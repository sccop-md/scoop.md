// Reference store for the v1 API. A JSON file stands in for D1 + R2; the
// semantics (ranking, dedupe, vote replacement, takedown) are what matter.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function newId(prefix, now = Date.now()) {
  return `${prefix}_${now.toString(36).padStart(9, '0')}${randomBytes(10).toString('hex')}`;
}

export function fingerprint(sections) {
  return sha256(JSON.stringify(sections.map((s) => [s.kind, s.url, s.content === null ? null : sha256(s.content)])));
}

// "The most recent skill that worked" (docs/BACKEND.md §7).
export function best(skills, site) {
  return skills
    .filter((s) => s.site === site && !s.removedAt && s.worked >= 1 && s.worked > s.failed)
    .sort((a, b) => b.lastWorkedAt.localeCompare(a.lastWorkedAt) || b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function summary(skill) {
  const { sections, relatedLinks, fingerprint: _f, createdBy: _c, removedAt: _r, votes: _v, ...rest } = skill;
  return {
    ...rest,
    sources: sections.map(({ kind, label, url }) => ({ kind, label, url })),
    sizeBytes: sections.reduce((n, s) => n + (s.content?.length ?? 0), 0),
  };
}

export function publicSkill(skill) {
  const { fingerprint: _f, createdBy: _c, removedAt: _r, votes: _v, ...rest } = skill;
  return rest;
}

export class Store {
  constructor(file) {
    this.file = file;
    this.skills = [];
    this.reports = [];
  }

  async load() {
    if (!this.file) return this;
    try {
      const data = JSON.parse(await readFile(this.file, 'utf8'));
      // The v0 prototype stored a bare array of skills without sections.
      if (!Array.isArray(data)) Object.assign(this, { skills: data.skills ?? [], reports: data.reports ?? [] });
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return this;
  }

  async save() {
    if (!this.file) return;
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify({ skills: this.skills, reports: this.reports }));
  }

  get(id) {
    return this.skills.find((s) => s.id === id) ?? null;
  }

  best(site) {
    return best(this.skills, site);
  }

  sites() {
    const bySite = new Map();
    for (const s of this.skills) if (!bySite.has(s.site)) bySite.set(s.site, best(this.skills, s.site));
    return [...bySite.entries()]
      .filter(([, b]) => b)
      .sort(([, a], [, b]) => b.lastWorkedAt.localeCompare(a.lastWorkedAt))
      .map(([site, b]) => ({ site, best: b }));
  }

  recent(site, limit = 20) {
    return this.skills
      .filter((s) => s.site === site && !s.removedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  hasSite(site) {
    return this.skills.some((s) => s.site === site);
  }

  async add({ site, pageUrl, title, sections, relatedLinks, installId }, now = new Date()) {
    const fp = fingerprint(sections);
    const dup = this.skills.find((s) => s.site === site && s.fingerprint === fp && !s.removedAt);
    if (dup) return { skill: dup, duplicate: true };
    const skill = {
      id: newId('sk', now.getTime()),
      site,
      pageUrl,
      title: title ?? '',
      sections,
      relatedLinks: relatedLinks ?? [],
      worked: 0,
      failed: 0,
      createdAt: now.toISOString(),
      lastWorkedAt: null,
      status: 'verified',
      fingerprint: fp,
      createdBy: installId,
      removedAt: null,
      votes: {},
    };
    this.skills.push(skill);
    await this.save();
    return { skill, duplicate: false };
  }

  // One vote per install; a new vote replaces the old one.
  async vote(skill, installId, worked, now = new Date()) {
    skill.votes[installId] = { worked, at: now.toISOString() };
    const votes = Object.values(skill.votes);
    skill.worked = votes.filter((v) => v.worked).length;
    skill.failed = votes.length - skill.worked;
    skill.lastWorkedAt = votes.filter((v) => v.worked).map((v) => v.at).sort().pop() ?? null;
    await this.save();
    return skill;
  }

  async report({ skillId, installId, reason, details }, now = new Date()) {
    this.reports.push({ id: newId('rp', now.getTime()), skillId, installId, reason, details: details ?? null, createdAt: now.toISOString(), resolvedAt: null });
    await this.save();
  }

  async remove(skill, now = new Date()) {
    skill.removedAt = now.toISOString();
    skill.sections = [];
    skill.relatedLinks = [];
    await this.save();
  }
}
