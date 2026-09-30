const DEFAULTS = { libraryUrl: 'http://localhost:8787', share: true };
const $ = (id) => document.getElementById(id);

chrome.storage.sync.get(DEFAULTS).then((s) => {
  $('libraryUrl').value = s.libraryUrl;
  $('share').checked = s.share;
});

$('save').onclick = async () => {
  await chrome.storage.sync.set({ libraryUrl: $('libraryUrl').value.trim(), share: $('share').checked });
  $('saved').textContent = 'Saved.';
};
