// The shared skill library. A JSON file is enough for a prototype; the shape
// is deliberately simple to move to a real database later.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_CONTENT = 1_000_000;

// "The most recent skill that worked": only skills people confirmed, where
// confirmations outnumber failures, newest confirmation first.
export function best(skills, site) {
  return skills
    .filter((s) => s.site === site && s.worked > 0 && s.worked > s.failed)
    .sort((a, b) => b.lastWorkedAt.localeCompare(a.lastWorkedAt))[0] ?? null;
}

export class Store {
  constructor(file) {
    this.file = file;
    this.skills = [];
  }

  async load() {
    try {
      this.skills = JSON.parse(await readFile(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    return this;
  }

  async save() {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(this.skills, null, 2));
  }

  best(site) {
    return best(this.skills, site);
  }

  async add({ site, sources, content }, now = new Date()) {
    if (typeof site !== 'string' || !site) throw new Error('site is required');
    if (typeof content !== 'string' || !content) throw new Error('content is required');
    if (content.length > MAX_CONTENT) throw new Error('content too large');
    const skill = {
      id: randomUUID(),
      site,
      sources: Array.isArray(sources) ? sources : [],
      content,
      createdAt: now.toISOString(),
      worked: 0,
      failed: 0,
      lastWorkedAt: null,
    };
    this.skills.push(skill);
    await this.save();
    return skill;
  }

  async feedback(id, worked, now = new Date()) {
    const skill = this.skills.find((s) => s.id === id);
    if (!skill) return null;
    if (worked) {
      skill.worked += 1;
      skill.lastWorkedAt = now.toISOString();
    } else {
      skill.failed += 1;
    }
    await this.save();
    return skill;
  }
}
