/*!
 * Obsidian Vault Image Organizer - core.js
 * --------------------------------
 * Shared foundation: constants, state, DOM/log/modal helpers, IndexedDB
 * persistence, vault selection, vault-wide indexing, reference parsing +
 * resolution, a vault-wide fuzzy image search (used when a reference is
 * broken so the Repair step can find the file wherever it actually lives),
 * and the safety guards that every write/delete in features.js must go
 * through:
 *
 *   - safeWriteMarkdown: backs up the note's current content before any
 *     write, and REFUSES the write outright if the new content is shorter
 *     or empty relative to the original. A markdown file is never destroyed.
 *   - safeDeleteImageFile: re-checks references immediately before deleting
 *     and only ever removes files with a recognised image extension.
 *
 * Everything is exposed on window.VO for features.js to consume.
 */
(function () {
  'use strict';

  // ===========================================================================
  // Constants
  // ===========================================================================
  var IMAGE_EXTENSIONS = ['.webp', '.png', '.jpg', '.jpeg', '.gif'];
  var ATTACH_FOLDER = 'attachments';
  var BACKUP_FOLDER = '.vault-organizer-backups';
  var REGEX_WIKI = /!\[\[([^\]|]+\.(?:webp|png|jpe?g|gif))\]\]/g;
  var REGEX_STANDARD = /!\[[^\]]*\]\(([^)]+\.(?:webp|png|jpe?g|gif))\)/g;

  // ===========================================================================
  // State
  // ===========================================================================
  var state = {
    rootHandle: null,
    pendingHandle: null,
    mdFiles: [],            // {path, name, handle, dirPath, dirHandle}
    imageIndex: new Map(),  // lowercase filename -> [entry]
    pathIndex: new Map(),   // lowercase full path -> entry
    allDirs: []             // {name, handle, path, parentHandle, parentPath}
  };

  // ===========================================================================
  // Small DOM helpers
  // ===========================================================================
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html !== undefined) n.innerHTML = html;
    return n;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }
  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
  }

  // ===========================================================================
  // Activity log
  // ===========================================================================
  var logCountEl = $('logCount');
  var logBodyEl = $('logBody');
  var logDrawerEl = $('logDrawer');
  var logToggleEl = $('logToggle');
  var logN = 0;
  function log(msg, level) {
    logN++;
    logCountEl.textContent = String(logN);
    var line = el('div', 'log-line log-' + (level || 'info'), escapeHtml(msg));
    logBodyEl.appendChild(line);
    logBodyEl.scrollTop = logBodyEl.scrollHeight;
  }
  logToggleEl.addEventListener('click', function () {
    var open = logDrawerEl.classList.toggle('open');
    logToggleEl.textContent = (open ? '▾ Activity log ' : '▸ Activity log ');
    var span = document.createElement('span');
    span.id = 'logCount';
    span.textContent = String(logN);
    logToggleEl.appendChild(span);
    logCountEl = span;
  });

  // ===========================================================================
  // Modal (returns a Promise<boolean>)
  // ===========================================================================
  var modalOverlay = $('modalOverlay');
  var modalTitle = $('modalTitle');
  var modalBody = $('modalBody');
  var modalCancel = $('modalCancel');
  var modalConfirm = $('modalConfirm');
  function confirmModal(title, bodyHtml, confirmLabel) {
    return new Promise(function (resolve) {
      modalTitle.textContent = title;
      modalBody.innerHTML = bodyHtml;
      modalConfirm.textContent = confirmLabel || 'Confirm';
      modalOverlay.hidden = false;
      function cleanup(result) {
        modalOverlay.hidden = true;
        modalCancel.removeEventListener('click', onCancel);
        modalConfirm.removeEventListener('click', onConfirm);
        resolve(result);
      }
      function onCancel() { cleanup(false); }
      function onConfirm() { cleanup(true); }
      modalCancel.addEventListener('click', onCancel);
      modalConfirm.addEventListener('click', onConfirm);
    });
  }

  // ===========================================================================
  // IndexedDB persistence (remembers the last vault)
  // ===========================================================================
  var DB_NAME = 'vault-organizer';
  var STORE = 'handles';
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore(STORE); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbSet(key, val) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(val, key);
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }
  function idbGet(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var r = tx.objectStore(STORE).get(key);
        r.onsuccess = function () { resolve(r.result); };
        r.onerror = function () { reject(r.error); };
      });
    });
  }

  // ===========================================================================
  // Browser / context capability checks
  // ===========================================================================
  var supported = !!window.showDirectoryPicker;
  if (!supported) $('unsupportedBanner').hidden = false;
  if (window.self !== window.top) $('iframeBanner').hidden = false;

  // ===========================================================================
  // Vault selection
  // ===========================================================================
  var vaultPill = $('vaultPill');
  var vaultLabel = $('vaultLabel');
  var btnSelectVault = $('btnSelectVault');
  var btnReconnect = $('btnReconnect');
  var indexSummary = $('indexSummary');

  function setVaultConnected(name) {
    vaultPill.classList.add('vault-pill-connected');
    vaultLabel.textContent = name;
    enableActionButtons(true);
  }
  function enableActionButtons(on) {
    ['btnRunAudit', 'btnScanRepairs', 'btnRunConsolidate', 'btnScanOrphans', 'btnScanDuplicates', 'btnScanEmptyFolders']
      .forEach(function (id) { var b = $(id); if (b) b.disabled = !on; });
  }

  btnSelectVault.addEventListener('click', function () {
    if (!supported) return;
    window.showDirectoryPicker({ mode: 'readwrite' }).then(function (handle) {
      state.rootHandle = handle;
      setVaultConnected(handle.name);
      btnReconnect.hidden = true;
      log('Vault selected: ' + handle.name, 'ok');
      return idbSet('lastVault', handle);
    }).catch(function (e) {
      if (e && e.name !== 'AbortError') log('Could not open folder: ' + e.message, 'err');
    });
  });

  if (supported && window.self === window.top) {
    idbGet('lastVault').then(function (handle) {
      if (handle) {
        state.pendingHandle = handle;
        btnReconnect.hidden = false;
        btnReconnect.textContent = 'Reconnect: ' + handle.name;
      }
    }).catch(function () { /* ignore - first run, no DB entry yet */ });
  }

  btnReconnect.addEventListener('click', function () {
    if (!state.pendingHandle) return;
    state.pendingHandle.queryPermission({ mode: 'readwrite' }).then(function (perm) {
      if (perm === 'granted') return 'granted';
      return state.pendingHandle.requestPermission({ mode: 'readwrite' });
    }).then(function (perm) {
      if (perm !== 'granted') { log('Permission was not granted for the last vault.', 'warn'); return; }
      state.rootHandle = state.pendingHandle;
      setVaultConnected(state.rootHandle.name);
      btnReconnect.hidden = true;
      log('Reconnected to vault: ' + state.rootHandle.name, 'ok');
    }).catch(function (e) { log('Reconnect failed: ' + e.message, 'err'); });
  });

  // ===========================================================================
  // Step / subtab navigation
  // ===========================================================================
  document.querySelectorAll('.step').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.step').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.panel').forEach(function (p) { p.classList.remove('active'); });
      btn.classList.add('active');
      $('panel-' + btn.dataset.step).classList.add('active');
    });
  });
  document.querySelectorAll('.subtab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var group = btn.closest('.subtabs');
      group.querySelectorAll('.subtab').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.subpanel').forEach(function (p) {
        if (p.id === 'sub-' + btn.dataset.sub) p.classList.add('active'); else p.classList.remove('active');
      });
      btn.classList.add('active');
    });
  });

  // ===========================================================================
  // Path helpers
  // ===========================================================================
  function getExt(name) {
    var i = name.lastIndexOf('.');
    return i === -1 ? '' : name.slice(i).toLowerCase();
  }
  function normalizeRelative(baseDirPath, relPath) {
    var relNorm = relPath.replace(/\\/g, '/');
    try { relNorm = decodeURIComponent(relNorm); } catch (e) { /* leave as-is if not encoded */ }
    var baseSegs = baseDirPath === '' ? [] : baseDirPath.split('/');
    var relSegs = relNorm.split('/').filter(function (s) { return s.length > 0; });
    var segs = baseSegs.slice();
    relSegs.forEach(function (s) {
      if (s === '.') return;
      if (s === '..') { if (segs.length > 0) segs.pop(); return; }
      segs.push(s);
    });
    return segs.join('/');
  }
  function dirHops(a, b) {
    var as = a === '' ? [] : a.split('/');
    var bs = b === '' ? [] : b.split('/');
    var min = Math.min(as.length, bs.length);
    var c = 0;
    for (var i = 0; i < min; i++) {
      if (as[i].toLowerCase() === bs[i].toLowerCase()) c++; else break;
    }
    return (as.length - c) + (bs.length - c);
  }
  function isSystemFolder(name) {
    return name === '.git' || name === '.obsidian' || name === BACKUP_FOLDER;
  }
  // Relative path from a markdown file's directory to a target vault path,
  // used by Repair when rewriting standard-style ![]() references.
  function relativize(fromDirPath, toPath) {
    var fromSegs = fromDirPath === '' ? [] : fromDirPath.split('/');
    var toSegs = toPath.split('/');
    var toFile = toSegs.pop();
    var i = 0;
    while (i < fromSegs.length && i < toSegs.length && fromSegs[i] === toSegs[i]) i++;
    var ups = fromSegs.length - i;
    var down = toSegs.slice(i);
    var parts = [];
    for (var k = 0; k < ups; k++) parts.push('..');
    parts = parts.concat(down);
    parts.push(toFile);
    return parts.length ? parts.join('/') : toFile;
  }

  // ===========================================================================
  // Recursive walk of the vault, building mdFiles / imageIndex / pathIndex
  // ===========================================================================
  function walkAsync(dirHandle, dirPath, skipSystem, out) {
    var iterator = dirHandle.entries();
    function step() {
      return iterator.next().then(function (res) {
        if (res.done) return Promise.resolve();
        var name = res.value[0];
        var handle = res.value[1];
        var entryPath = dirPath ? dirPath + '/' + name : name;
        if (handle.kind === 'directory') {
          if (skipSystem && isSystemFolder(name)) return step();
          out.dirs.push({ name: name, handle: handle, path: entryPath, parentHandle: dirHandle, parentPath: dirPath });
          return walkAsync(handle, entryPath, skipSystem, out).then(step);
        } else {
          out.files.push({ name: name, handle: handle, path: entryPath, parentHandle: dirHandle, parentPath: dirPath });
          return step();
        }
      });
    }
    return step();
  }

  function buildIndexes() {
    log('Building file indexes…', 'info');
    state.mdFiles = [];
    state.imageIndex = new Map();
    state.pathIndex = new Map();
    state.allDirs = [];
    var skipSystem = $('skipSystemFolders').checked;
    var out = { dirs: [], files: [] };
    return walkAsync(state.rootHandle, '', skipSystem, out).then(function () {
      state.allDirs = out.dirs;
      out.files.forEach(function (f) {
        if (f.name.toLowerCase().endsWith('.md')) {
          state.mdFiles.push({ path: f.path, name: f.name, handle: f.handle, dirPath: f.parentPath, dirHandle: f.parentHandle });
        } else {
          var ext = getExt(f.name);
          if (IMAGE_EXTENSIONS.indexOf(ext) !== -1) {
            var entry = { path: f.path, name: f.name, handle: f.handle, dirPath: f.parentPath, dirHandle: f.parentHandle };
            var key = f.name.toLowerCase();
            if (!state.imageIndex.has(key)) state.imageIndex.set(key, []);
            state.imageIndex.get(key).push(entry);
            state.pathIndex.set(f.path.toLowerCase(), entry);
          }
        }
      });
      var totalImages = 0;
      state.imageIndex.forEach(function (arr) { totalImages += arr.length; });
      log('Markdown files: ' + state.mdFiles.length + '  |  unique image names: ' + state.imageIndex.size + '  (' + totalImages + ' files total)', 'ok');
      indexSummary.hidden = false;
      indexSummary.innerHTML = '<b>' + state.mdFiles.length + '</b> notes &nbsp;·&nbsp; <b>' + totalImages + '</b> images &nbsp;·&nbsp; <b>' + state.imageIndex.size + '</b> unique names';
    });
  }

  function findImageByExactPath(path) {
    return state.pathIndex.get(path.toLowerCase()) || null;
  }

  function getOrCreateDir(parentHandle, name) {
    return parentHandle.getDirectoryHandle(name, { create: true });
  }

  // ===========================================================================
  // Reference parsing + resolution
  // ===========================================================================
  function parseRefs(content) {
    var refs = [];
    var seen = new Set();
    var m;
    REGEX_WIKI.lastIndex = 0;
    while ((m = REGEX_WIKI.exec(content))) {
      var rawInner = m[1];
      var fileName = rawInner.split('/').pop().split('\\').pop();
      var wkey = 'wiki:' + fileName.toLowerCase();
      if (!seen.has(wkey)) {
        seen.add(wkey);
        refs.push({ raw: m[0], isOnline: false, fileName: fileName, relPath: null, isWiki: true });
      }
    }
    REGEX_STANDARD.lastIndex = 0;
    while ((m = REGEX_STANDARD.exec(content))) {
      var target = m[1].trim();
      var isOnline = /^https?:\/\//i.test(target);
      var skey = 'std:' + target.toLowerCase();
      if (!seen.has(skey)) {
        seen.add(skey);
        var sFileName = target.split('/').pop().split('\\').pop();
        refs.push({ raw: m[0], isOnline: isOnline, fileName: sFileName, relPath: isOnline ? null : target, isWiki: false });
      }
    }
    return refs;
  }

  // This is the "look throughout the entire project" step: it always falls
  // back to a vault-wide search by filename (imageIndex is keyed by every
  // image filename found anywhere under the vault root), regardless of
  // where the reference's relative path or wiki-link pointed.
  function resolveRef(ref, mdDirPath) {
    var attachPath = (mdDirPath ? mdDirPath + '/' : '') + ATTACH_FOLDER + '/' + ref.fileName;
    var exact = findImageByExactPath(attachPath);
    if (exact) return { found: true, sourcePath: exact.path, sourceEntry: exact, isClean: true, strategy: 'attachments' };

    if (ref.relPath) {
      var resolvedPath = normalizeRelative(mdDirPath, ref.relPath);
      var exact2 = findImageByExactPath(resolvedPath);
      if (exact2) return { found: true, sourcePath: resolvedPath, sourceEntry: exact2, isClean: false, strategy: 'relative path' };
    }

    var key = ref.fileName.toLowerCase();
    if (state.imageIndex.has(key)) {
      var candidates = state.imageIndex.get(key);
      var best = null, bestHops = Infinity, bestLen = Infinity;
      candidates.forEach(function (c) {
        var hops = dirHops(mdDirPath, c.dirPath);
        var len = c.path.length;
        if (hops < bestHops || (hops === bestHops && len < bestLen) ||
            (hops === bestHops && len === bestLen && (!best || c.path < best.path))) {
          best = c; bestHops = hops; bestLen = len;
        }
      });
      return { found: true, sourcePath: best.path, sourceEntry: best, isClean: false, strategy: 'found elsewhere in vault' };
    }
    return { found: false, sourcePath: null, sourceEntry: null, isClean: false, strategy: null };
  }

  // ===========================================================================
  // Fuzzy filename matching - used by Repair when a reference can't be
  // resolved by exact filename at all (e.g. a typo, renamed extension, or
  // mangled path). Searches every image filename indexed anywhere in the
  // vault and returns the closest matches by edit distance, never auto-
  // applied - the user always picks/confirms in the UI.
  // ===========================================================================
  function levenshtein(a, b) {
    a = a.toLowerCase(); b = b.toLowerCase();
    var m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    var prev = new Array(n + 1);
    var cur = new Array(n + 1);
    for (var j = 0; j <= n; j++) prev[j] = j;
    for (var i = 1; i <= m; i++) {
      cur[0] = i;
      for (j = 1; j <= n; j++) {
        var cost = a[i - 1] === b[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return prev[n];
  }

  function findFuzzyCandidates(ref, maxDistance) {
    var name = ref.fileName;
    var base = name.replace(/\.[^.]+$/, '');
    var results = [];
    state.imageIndex.forEach(function (entries) {
      entries.forEach(function (entry) {
        var entryBase = entry.name.replace(/\.[^.]+$/, '');
        var d = levenshtein(base, entryBase);
        if (d <= maxDistance) results.push({ entry: entry, distance: d });
      });
    });
    results.sort(function (x, y) { return x.distance - y.distance || x.entry.path.length - y.entry.path.length; });
    // de-dupe by path, cap at 5 suggestions
    var seen = new Set(), out = [];
    results.forEach(function (r) {
      if (seen.has(r.entry.path)) return;
      seen.add(r.entry.path);
      if (out.length < 5) out.push(r);
    });
    return out;
  }

  // ===========================================================================
  // Reference sets - every name/path referenced by any note (used by Cleanup
  // to decide what's orphaned).
  // ===========================================================================
  function buildReferenceSets() {
    var referencedNames = new Set();
    var referencedPaths = new Set();
    var n = state.mdFiles.length;
    var i = 0;
    function step() {
      if (i >= n) return Promise.resolve();
      var md = state.mdFiles[i];
      return md.handle.getFile().then(function (file) { return file.text(); }).then(function (content) {
        parseRefs(content).filter(function (r) { return !r.isOnline; }).forEach(function (ref) {
          referencedNames.add(ref.fileName.toLowerCase());
          if (ref.relPath) referencedPaths.add(normalizeRelative(md.dirPath, ref.relPath).toLowerCase());
        });
        i++;
        return step();
      }).catch(function (e) {
        log('Read error in ' + md.path + ': ' + e.message, 'err');
        i++;
        return step();
      });
    }
    return step().then(function () { return { referencedNames: referencedNames, referencedPaths: referencedPaths }; });
  }

  // ===========================================================================
  // SAFETY GUARDS
  // ===========================================================================

  // safeWriteMarkdown: NEVER destroys a markdown file.
  //  1. Writes a timestamped backup of the original content to
  //     <BACKUP_FOLDER>/ (mirroring the note's path) before touching the file.
  //  2. Refuses outright - throws, writes nothing - if the new content is
  //     empty, or shorter than some sane fraction of the original. A note
  //     should only ever grow or stay the same rough size from a reference
  //     rewrite; a big shrink almost certainly means something went wrong
  //     upstream (bad regex match, truncated read, etc).
  //  3. No-ops (skipped:true) if old and new content are identical.
  function safeWriteMarkdown(mdRef, originalContent, newContent) {
    if (newContent === originalContent) return Promise.resolve({ skipped: true });
    if (newContent.trim().length === 0) {
      return Promise.reject(new Error('refused: new content is empty'));
    }
    // allow shrinkage from removing trailing whitespace etc, but never let
    // a rewrite blow away the bulk of a note
    if (originalContent.length > 0 && newContent.length < originalContent.length * 0.5) {
      return Promise.reject(new Error('refused: new content is less than half the original size (' + newContent.length + ' vs ' + originalContent.length + ' chars)'));
    }
    return backupMarkdown(mdRef, originalContent).then(function () {
      return mdRef.handle.createWritable().then(function (writable) {
        return writable.write(newContent).then(function () { return writable.close(); });
      });
    }).then(function () { return { skipped: false }; });
  }

  function backupMarkdown(mdRef, content) {
    var ts = new Date().toISOString().replace(/[:.]/g, '-');
    var backupRelDir = BACKUP_FOLDER + (mdRef.dirPath ? '/' + mdRef.dirPath : '');
    var segs = backupRelDir.split('/').filter(function (s) { return s.length > 0; });
    var dirChain = Promise.resolve(state.rootHandle);
    segs.forEach(function (seg) {
      dirChain = dirChain.then(function (h) { return getOrCreateDir(h, seg); });
    });
    return dirChain.then(function (dirHandle) {
      var backupName = mdRef.name + '.' + ts + '.bak';
      return dirHandle.getFileHandle(backupName, { create: true }).then(function (fh) {
        return fh.createWritable().then(function (writable) {
          return writable.write(content).then(function () { return writable.close(); });
        });
      });
    });
  }

  // safeDeleteImageFile: re-checks the file is still a recognised image
  // extension before deleting (defence in depth - never deletes a .md or
  // anything else, no matter what gets passed in). Callers are additionally
  // expected to re-check references right before calling this.
  function safeDeleteImageFile(entry) {
    var ext = getExt(entry.name);
    if (IMAGE_EXTENSIONS.indexOf(ext) === -1) {
      return Promise.reject(new Error('refused: not a recognised image extension (' + entry.name + ')'));
    }
    return entry.dirHandle.removeEntry(entry.name);
  }

  // ===========================================================================
  // Progress helper
  // ===========================================================================
  function setProgress(prefix, text, pct) {
    $(prefix + 'ProgressText') && ($(prefix + 'ProgressText').textContent = text);
    var pctEl = $(prefix + 'ProgressPct');
    var fillEl = $(prefix + 'ProgressFill');
    if (pctEl) pctEl.textContent = (pct == null ? '' : Math.round(pct) + '%');
    if (fillEl) fillEl.style.width = (pct == null ? 0 : pct) + '%';
  }

  // ===========================================================================
  // Export
  // ===========================================================================
  window.VO = {
    IMAGE_EXTENSIONS: IMAGE_EXTENSIONS,
    ATTACH_FOLDER: ATTACH_FOLDER,
    BACKUP_FOLDER: BACKUP_FOLDER,
    state: state,
    $: $, el: el, escapeHtml: escapeHtml, formatBytes: formatBytes,
    log: log, confirmModal: confirmModal, setProgress: setProgress,
    getExt: getExt, normalizeRelative: normalizeRelative, relativize: relativize, dirHops: dirHops, isSystemFolder: isSystemFolder,
    buildIndexes: buildIndexes, findImageByExactPath: findImageByExactPath, getOrCreateDir: getOrCreateDir,
    parseRefs: parseRefs, resolveRef: resolveRef, findFuzzyCandidates: findFuzzyCandidates,
    buildReferenceSets: buildReferenceSets,
    safeWriteMarkdown: safeWriteMarkdown, safeDeleteImageFile: safeDeleteImageFile
  };
})();
