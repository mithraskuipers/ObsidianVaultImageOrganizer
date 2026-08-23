/*!
 * Obsidian Vault Image Organizer - features.js
 * ------------------------------------
 * The four workflow steps:
 *   1. Audit       - read-only report of every image reference.
 *   2. Repair       - relinks broken image references to wherever the file
 *                      actually lives anywhere in the vault, fixes messy
 *                      path syntax, and suggests fuzzy matches for refs that
 *                      can't be resolved exactly (never auto-applied).
 *   3. Consolidate  - copies images into attachments/ and rewrites refs.
 *   4. Cleanup      - orphaned images, duplicate images, and empty folders
 *                      (structure cleanup).
 *
 * Every write goes through VO.safeWriteMarkdown (backup + never-shrink
 * guard) and every delete through VO.safeDeleteImageFile. Image references
 * are never guessed at automatically - only deterministic, found-on-disk
 * matches are applied without confirmation; everything else is a suggestion
 * the user has to tick and confirm.
 *
 * Depends on core.js being loaded first (uses window.VO).
 */
(function () {
  'use strict';

  var VO = window.VO;
  var $ = VO.$, el = VO.el, escapeHtml = VO.escapeHtml, formatBytes = VO.formatBytes;
  var log = VO.log, confirmModal = VO.confirmModal, setProgress = VO.setProgress;

  // ===========================================================================
  // AUDIT (read-only)
  // ===========================================================================
  $('btnRunAudit').addEventListener('click', function () {
    var btn = $('btnRunAudit');
    btn.disabled = true;
    $('auditEmpty').hidden = true;
    $('auditResults').innerHTML = '';
    $('auditBroken').hidden = true;
    $('auditStats').hidden = true;
    var prog = $('auditProgress');
    prog.hidden = false;
    setProgress('audit', 'Building indexes…', 0);

    VO.buildIndexes().then(function () {
      var totals = { refs: 0, clean: 0, needs: 0, broken: 0, online: 0 };
      var brokenList = [];
      var results = [];
      var n = VO.state.mdFiles.length;
      var i = 0;

      function step() {
        if (i >= n) return Promise.resolve();
        var md = VO.state.mdFiles[i];
        setProgress('audit', md.path, ((i + 1) / Math.max(n, 1)) * 100);
        return md.handle.getFile().then(function (file) { return file.text(); }).then(function (content) {
          var refs = VO.parseRefs(content);
          if (refs.length > 0) {
            var fileResult = { path: md.path, refs: [] };
            refs.forEach(function (ref) {
              totals.refs++;
              if (ref.isOnline) {
                totals.online++;
                fileResult.refs.push({ fileName: ref.fileName, status: 'online' });
                return;
              }
              var r = VO.resolveRef(ref, md.dirPath);
              if (!r.found) {
                totals.broken++;
                fileResult.refs.push({ fileName: ref.fileName, status: 'broken' });
                brokenList.push({ path: md.path, raw: ref.raw });
              } else if (r.isClean) {
                totals.clean++;
                fileResult.refs.push({ fileName: ref.fileName, status: 'clean' });
              } else {
                totals.needs++;
                fileResult.refs.push({ fileName: ref.fileName, status: 'needs', foundAt: r.sourcePath });
              }
            });
            results.push(fileResult);
          }
          i++;
          return step();
        }).catch(function (e) {
          log('Read error in ' + md.path + ': ' + e.message, 'err');
          i++;
          return step();
        });
      }

      return step().then(function () {
        renderAudit(results, totals, brokenList);
        log('Audit complete - ' + totals.refs + ' refs (' + totals.clean + ' clean, ' + totals.needs + ' need consolidation, ' + totals.broken + ' broken, ' + totals.online + ' online)', 'ok');
      });
    }).catch(function (e) {
      log('Audit failed: ' + e.message, 'err');
    }).then(function () {
      prog.hidden = true;
      btn.disabled = false;
    });
  });

  function statusBadge(status) {
    var map = { clean: 'Clean', needs: 'Needs', broken: 'Broken', online: 'Online' };
    return '<span class="badge badge-' + status + '">' + map[status] + '</span>';
  }

  function renderAudit(results, totals, brokenList) {
    $('statMdFiles').textContent = VO.state.mdFiles.length;
    $('statTotalRefs').textContent = totals.refs;
    $('statClean').textContent = totals.clean;
    $('statNeeds').textContent = totals.needs;
    $('statBroken').textContent = totals.broken;
    $('statOnline').textContent = totals.online;
    $('auditStats').hidden = false;

    var container = $('auditResults');
    container.innerHTML = '';
    if (results.length === 0) {
      $('auditEmpty').hidden = false;
      $('auditEmpty').textContent = 'No image references found in this vault.';
    } else {
      results.forEach(function (fr) {
        var counts = { clean: 0, needs: 0, broken: 0, online: 0 };
        fr.refs.forEach(function (r) { counts[r.status]++; });
        var details = el('details', 'file-group');
        var summary = el('summary', null,
          '<span class="fpath">' + escapeHtml(fr.path) + '</span>' +
          '<span class="fcounts">' +
            (counts.broken ? '<span class="mini" style="color:var(--rust)">' + counts.broken + ' broken</span>' : '') +
            (counts.needs ? '<span class="mini" style="color:var(--amber)">' + counts.needs + ' needs</span>' : '') +
            (counts.clean ? '<span class="mini" style="color:var(--teal)">' + counts.clean + ' clean</span>' : '') +
          '</span>'
        );
        details.appendChild(summary);
        var rows = el('div', 'ref-rows');
        fr.refs.forEach(function (r) {
          var row = el('div', 'ref-row');
          row.innerHTML = statusBadge(r.status) + '<span class="fname">' + escapeHtml(r.fileName) + '</span>' +
            (r.foundAt ? '<span class="found-at">' + escapeHtml(r.foundAt) + '</span>' : '');
          rows.appendChild(row);
        });
        details.appendChild(rows);
        container.appendChild(details);
      });
    }

    if (brokenList.length > 0) {
      $('auditBroken').hidden = false;
      var rowsEl = $('auditBrokenRows');
      rowsEl.innerHTML = '';
      brokenList.forEach(function (b) {
        rowsEl.appendChild(el('div', 'row', escapeHtml(b.path) + '  →  ' + escapeHtml(b.raw)));
      });
    }
  }

  // ===========================================================================
  // REPAIR - relinks broken refs to wherever the image actually lives
  // anywhere in the vault, and cleans up path syntax. Never touches refs
  // that are already correct. Fuzzy suggestions are never auto-applied.
  // ===========================================================================
  var repairGroups = []; // {path, dirPath, name, handle, dirHandle, originalContent, fixes:[], suggestions:[]}

  // What a reference's raw text *should* be, given a deterministic
  // resolution. Returns null when already correct (minimal diffs only).
  function buildIdealRaw(ref, r, mdDirPath) {
    if (!r.found) return null;
    if (ref.isWiki) {
      if (r.strategy === 'attachments') return null; // already correct, don't touch
      var key = r.sourceEntry.name.toLowerCase();
      var sameNameCount = (VO.state.imageIndex.get(key) || []).length;
      var targetInner = sameNameCount === 1 ? r.sourceEntry.name : r.sourcePath;
      return '![[' + targetInner + ']]';
    } else {
      var relTarget = VO.relativize(mdDirPath, r.sourcePath);
      var altMatch = /^!\[([^\]]*)\]/.exec(ref.raw);
      var alt = altMatch ? altMatch[1] : '';
      return '![' + alt + '](' + relTarget + ')';
    }
  }

  $('btnScanRepairs').addEventListener('click', function () {
    var btn = $('btnScanRepairs');
    btn.disabled = true;
    $('repairEmpty').hidden = true;
    $('repairResults').hidden = true;
    $('repairStats').hidden = true;
    var prog = $('repairProgress');
    prog.hidden = false;
    setProgress('repair', 'Building indexes…', 0);

    VO.buildIndexes().then(function () {
      var n = VO.state.mdFiles.length;
      var i = 0;
      var groups = [];
      var totals = { filesScanned: 0, fixable: 0, suggestions: 0, unmatched: 0 };

      function step() {
        if (i >= n) return Promise.resolve();
        var md = VO.state.mdFiles[i];
        setProgress('repair', md.path, ((i + 1) / Math.max(n, 1)) * 100);
        return md.handle.getFile().then(function (file) { return file.text(); }).then(function (content) {
          totals.filesScanned++;
          var refs = VO.parseRefs(content).filter(function (r) { return !r.isOnline; });
          var fixes = [];
          var suggestions = [];
          refs.forEach(function (ref) {
            var r = VO.resolveRef(ref, md.dirPath);
            if (r.found) {
              var proposed = buildIdealRaw(ref, r, md.dirPath);
              if (proposed && proposed !== ref.raw) {
                fixes.push({ ref: ref, newRaw: proposed, strategy: r.strategy });
                totals.fixable++;
              }
            } else {
              var candidates = VO.findFuzzyCandidates(ref, 3);
              if (candidates.length > 0) {
                suggestions.push({ ref: ref, candidates: candidates });
                totals.suggestions++;
              } else {
                totals.unmatched++;
              }
            }
          });
          if (fixes.length > 0 || suggestions.length > 0) {
            groups.push({
              path: md.path, dirPath: md.dirPath, name: md.name, handle: md.handle, dirHandle: md.dirHandle,
              originalContent: content, fixes: fixes, suggestions: suggestions
            });
          }
          i++;
          return step();
        }).catch(function (e) {
          log('Read error in ' + md.path + ': ' + e.message, 'err');
          i++;
          return step();
        });
      }

      return step().then(function () {
        repairGroups = groups;
        renderRepairs(totals);
        log('Repair scan complete - ' + totals.fixable + ' fixable, ' + totals.suggestions + ' possible match(es), ' + totals.unmatched + ' unmatched', 'ok');
      });
    }).catch(function (e) {
      log('Repair scan failed: ' + e.message, 'err');
    }).then(function () {
      prog.hidden = true;
      btn.disabled = false;
    });
  });

  function renderRepairs(totals) {
    $('repairStatFiles').textContent = totals.filesScanned;
    $('repairStatFixable').textContent = totals.fixable;
    $('repairStatSuggestions').textContent = totals.suggestions;
    $('repairStatUnmatched').textContent = totals.unmatched;
    $('repairStats').hidden = false;

    var container = $('repairResults');
    container.innerHTML = '';
    if (repairGroups.length === 0) {
      $('repairEmpty').hidden = false;
      $('repairEmpty').textContent = 'Nothing to fix - every reference that can be resolved already points at the right place.';
      $('repairResults').hidden = true;
      return;
    }

    repairGroups.forEach(function (grp, gi) {
      var details = el('details', 'file-group');
      var summary = el('summary', null,
        '<span class="fpath">' + escapeHtml(grp.path) + '</span>' +
        '<span class="fcounts">' +
          (grp.fixes.length ? '<span class="mini" style="color:var(--teal)">' + grp.fixes.length + ' fixable</span>' : '') +
          (grp.suggestions.length ? '<span class="mini" style="color:var(--amber)">' + grp.suggestions.length + ' possible</span>' : '') +
        '</span>'
      );
      details.appendChild(summary);
      var rows = el('div', 'ref-rows');

      grp.fixes.forEach(function (fx, fi) {
        var row = el('div', 'repair-row');
        row.innerHTML =
          '<input type="checkbox" class="fix-check" checked data-g="' + gi + '" data-f="' + fi + '">' +
          '<div class="rtext"><span class="badge badge-fix">Fix</span> ' +
          '<span class="rfrom">' + escapeHtml(fx.ref.raw) + '</span><span class="rarrow">&rarr;</span><span class="rto">' + escapeHtml(fx.newRaw) + '</span>' +
          '<div class="rnote">matched by ' + escapeHtml(fx.strategy || 'syntax cleanup') + '</div></div>';
        rows.appendChild(row);
      });

      grp.suggestions.forEach(function (sg, si) {
        var row = el('div', 'repair-row');
        var candHtml = sg.candidates.map(function (c, ci) {
          return '<label class="rcandidate"><input type="radio" name="sugg-' + gi + '-' + si + '" class="sugg-radio" data-g="' + gi + '" data-s="' + si + '" data-c="' + ci + '"' + (ci === 0 ? ' checked' : '') + '> ' +
            escapeHtml(c.entry.path) + ' <span style="opacity:.7">(similarity check: ' + c.distance + ' edit' + (c.distance === 1 ? '' : 's') + ')</span></label>';
        }).join('');
        row.innerHTML =
          '<input type="checkbox" class="sugg-apply" data-g="' + gi + '" data-s="' + si + '">' +
          '<div class="rtext"><span class="badge badge-suggest">Possible match</span> <span class="rfrom">' + escapeHtml(sg.ref.raw) + '</span>' +
          '<div class="rcandidates">' + candHtml + '</div>' +
          '<div class="rnote">Not applied automatically - tick the box and confirm the right candidate, then apply.</div></div>';
        rows.appendChild(row);
      });

      details.appendChild(rows);
      container.appendChild(details);
    });
    $('repairResults').hidden = false;
  }

  $('repairSelectAll').addEventListener('click', function () {
    document.querySelectorAll('.fix-check').forEach(function (cb) { cb.checked = true; });
  });
  $('repairSelectNone').addEventListener('click', function () {
    document.querySelectorAll('.fix-check').forEach(function (cb) { cb.checked = false; });
  });

  $('btnApplyRepairs').addEventListener('click', function () {
    var toApply = [];
    repairGroups.forEach(function (grp, gi) {
      var replacements = [];
      grp.fixes.forEach(function (fx, fi) {
        var cb = document.querySelector('.fix-check[data-g="' + gi + '"][data-f="' + fi + '"]');
        if (cb && cb.checked) replacements.push({ oldRaw: fx.ref.raw, newRaw: fx.newRaw });
      });
      grp.suggestions.forEach(function (sg, si) {
        var apply = document.querySelector('.sugg-apply[data-g="' + gi + '"][data-s="' + si + '"]');
        if (apply && apply.checked) {
          var radio = document.querySelector('.sugg-radio[data-g="' + gi + '"][data-s="' + si + '"]:checked');
          var ci = radio ? Number(radio.dataset.c) : 0;
          var chosen = sg.candidates[ci];
          var altMatch = /^!\[([^\]]*)\]/.exec(sg.ref.raw);
          var alt = altMatch ? altMatch[1] : '';
          var newRaw = sg.ref.isWiki
            ? '![[' + chosen.entry.path + ']]'
            : '![' + alt + '](' + VO.relativize(grp.dirPath, chosen.entry.path) + ')';
          replacements.push({ oldRaw: sg.ref.raw, newRaw: newRaw });
        }
      });
      if (replacements.length > 0) toApply.push({ grp: grp, replacements: replacements });
    });

    if (toApply.length === 0) { log('No repairs selected to apply.', 'warn'); return; }

    var totalChanges = toApply.reduce(function (s, t) { return s + t.replacements.length; }, 0);
    var listHtml = toApply.map(function (t) { return escapeHtml(t.grp.path) + ' - ' + t.replacements.length + ' change(s)'; }).join('<br>');
    confirmModal(
      'Apply ' + totalChanges + ' fix(es) across ' + toApply.length + ' note(s)?',
      'A backup of each note\'s current content is written to <code>' + VO.BACKUP_FOLDER + '/</code> before it is changed, and the write is refused outright if it would shrink or empty the note.' +
      '<div class="targets">' + listHtml + '</div>',
      'Apply fixes'
    ).then(function (ok) {
      if (!ok) return;
      var btn = $('btnApplyRepairs');
      btn.disabled = true;
      var applied = 0, errors = 0;
      var chain = Promise.resolve();
      toApply.forEach(function (t) {
        chain = chain.then(function () {
          var content = t.grp.originalContent;
          t.replacements.forEach(function (r) {
            content = content.split(r.oldRaw).join(r.newRaw);
          });
          var mdRef = { path: t.grp.path, name: t.grp.name, handle: t.grp.handle, dirPath: t.grp.dirPath, dirHandle: t.grp.dirHandle };
          return VO.safeWriteMarkdown(mdRef, t.grp.originalContent, content).then(function (res) {
            if (!res.skipped) {
              applied++;
              log('Repaired ' + t.replacements.length + ' reference(s) in ' + t.grp.path, 'ok');
            }
          }).catch(function (e) {
            errors++;
            log('Repair write refused for ' + t.grp.path + ': ' + e.message, 'err');
          });
        });
      });
      chain.then(function () {
        log('Repair apply complete - ' + applied + ' note(s) updated' + (errors ? ', ' + errors + ' refused/error(s)' : ''), errors ? 'warn' : 'ok');
        btn.disabled = false;
        $('btnScanRepairs').click(); // rescan so the panel reflects the new state
      });
    });
  });

  // ===========================================================================
  // CONSOLIDATE
  // ===========================================================================
  $('btnRunConsolidate').addEventListener('click', function () {
    confirmModal(
      'Consolidate the vault?',
      'This creates <code>attachments/</code> folders, copies images into them, and rewrites image references in your notes.<br><br>' +
      'Images are copied, never moved - your originals stay where they are. Every note is backed up to <code>' + VO.BACKUP_FOLDER + '/</code> before it is rewritten, and a write is refused if it would shrink or empty the note.',
      'Yes, consolidate'
    ).then(function (ok) {
      if (!ok) return;
      runConsolidate();
    });
  });

  function runConsolidate() {
    var btn = $('btnRunConsolidate');
    btn.disabled = true;
    $('consolidateStats').hidden = true;
    $('consolidateErrors').hidden = true;
    var prog = $('consolidateProgress');
    prog.hidden = false;
    setProgress('consolidate', 'Building indexes…', 0);

    VO.buildIndexes().then(function () {
      var stats = { mdProcessed: 0, mdModified: 0, totalRefs: 0, alreadyClean: 0, copied: 0, broken: 0, errors: 0, errorDetails: [] };
      var n = VO.state.mdFiles.length;
      var i = 0;

      function step() {
        if (i >= n) return Promise.resolve();
        var md = VO.state.mdFiles[i];
        setProgress('consolidate', md.path, ((i + 1) / Math.max(n, 1)) * 100);

        return md.handle.getFile().then(function (file) { return file.text(); }).then(function (content) {
          var originalContent = content;
          var refs = VO.parseRefs(content).filter(function (r) { return !r.isOnline; });
          stats.mdProcessed++;
          if (refs.length === 0) { i++; return step(); }
          stats.totalRefs += refs.length;

          var chain = Promise.resolve();

          refs.forEach(function (ref) {
            chain = chain.then(function () {
              var r = VO.resolveRef(ref, md.dirPath);
              if (!r.found) {
                stats.broken++;
                log('BROKEN (skipped): ' + ref.fileName + ' in ' + md.path, 'warn');
                return;
              }
              var destPath = (md.dirPath ? md.dirPath + '/' : '') + VO.ATTACH_FOLDER + '/' + ref.fileName;

              var copyStep;
              if (r.isClean) {
                stats.alreadyClean++;
                copyStep = Promise.resolve();
              } else {
                var existing = VO.findImageByExactPath(destPath);
                if (existing) {
                  stats.alreadyClean++;
                  copyStep = Promise.resolve();
                } else {
                  copyStep = VO.getOrCreateDir(md.dirHandle, VO.ATTACH_FOLDER).then(function (attachDirHandle) {
                    return r.sourceEntry.handle.getFile().then(function (srcFile) {
                      return attachDirHandle.getFileHandle(ref.fileName, { create: true }).then(function (destHandle) {
                        return destHandle.createWritable().then(function (writable) {
                          return writable.write(srcFile).then(function () { return writable.close(); }).then(function () {
                            stats.copied++;
                            var newEntry = {
                              path: destPath, name: ref.fileName, handle: destHandle,
                              dirPath: (md.dirPath ? md.dirPath + '/' : '') + VO.ATTACH_FOLDER, dirHandle: attachDirHandle
                            };
                            VO.state.pathIndex.set(destPath.toLowerCase(), newEntry);
                            var key = ref.fileName.toLowerCase();
                            if (!VO.state.imageIndex.has(key)) VO.state.imageIndex.set(key, []);
                            VO.state.imageIndex.get(key).push(newEntry);
                            log('Copied ' + ref.fileName + ' → ' + destPath, 'ok');
                          });
                        });
                      });
                    });
                  }).catch(function (e) {
                    stats.errors++;
                    var msg = 'Copy error for ' + ref.fileName + ' in ' + md.path + ': ' + e.message;
                    stats.errorDetails.push(msg);
                    log(msg, 'err');
                  });
                }
              }

              return copyStep.then(function () {
                var newRef = '![[' + VO.ATTACH_FOLDER + '/' + ref.fileName + ']]';
                if (ref.raw !== newRef) {
                  content = content.split(ref.raw).join(newRef);
                }
              });
            });
          });

          return chain.then(function () {
            if (content === originalContent) { i++; return step(); }
            return VO.safeWriteMarkdown(md, originalContent, content).then(function (res) {
              if (!res.skipped) {
                stats.mdModified++;
                log('Rewrote references in ' + md.path, 'ok');
              }
            }).catch(function (e) {
              stats.errors++;
              var msg = 'Write refused for ' + md.path + ': ' + e.message;
              stats.errorDetails.push(msg);
              log(msg, 'err');
            }).then(function () { i++; return step(); });
          });
        }).catch(function (e) {
          log('Read error in ' + md.path + ': ' + e.message, 'err');
          i++;
          return step();
        });
      }

      return step().then(function () { renderConsolidate(stats); });
    }).catch(function (e) {
      log('Consolidate failed: ' + e.message, 'err');
    }).then(function () {
      prog.hidden = true;
      btn.disabled = false;
    });
  }

  function renderConsolidate(stats) {
    $('cStatMdProcessed').textContent = stats.mdProcessed;
    $('cStatMdModified').textContent = stats.mdModified;
    $('cStatClean').textContent = stats.alreadyClean;
    $('cStatCopied').textContent = stats.copied;
    $('cStatBroken').textContent = stats.broken;
    $('cStatErrors').textContent = stats.errors;
    $('consolidateStats').hidden = false;

    if (stats.errorDetails.length > 0) {
      $('consolidateErrors').hidden = false;
      var rowsEl = $('consolidateErrorRows');
      rowsEl.innerHTML = '';
      stats.errorDetails.forEach(function (e) {
        rowsEl.appendChild(el('div', 'row', escapeHtml(e)));
      });
    }
    log('Consolidate complete - ' + stats.copied + ' copied, ' + stats.mdModified + ' notes rewritten, ' + stats.broken + ' broken, ' + stats.errors + ' errors', 'ok');
  }

  // ===========================================================================
  // CLEANUP: ORPHANS
  // ===========================================================================
  var orphanRows = []; // {entry, isLastCopy, otherCopies}

  $('btnScanOrphans').addEventListener('click', function () {
    var btn = $('btnScanOrphans');
    btn.disabled = true;
    $('orphansEmpty').hidden = true;
    $('orphansResults').hidden = true;
    $('orphansProgress').hidden = false;
    $('orphansProgressText').textContent = 'Building indexes…';

    VO.buildIndexes().then(function () {
      $('orphansProgressText').textContent = 'Reading references from notes…';
      return VO.buildReferenceSets();
    }).then(function (sets) {
      $('orphansProgressText').textContent = 'Finding orphans…';
      orphanRows = [];
      VO.state.imageIndex.forEach(function (entries, key) {
        var nameRef = sets.referencedNames.has(key);
        entries.forEach(function (entry) {
          var pathRef = sets.referencedPaths.has(entry.path.toLowerCase());
          if (!nameRef && !pathRef) {
            var others = entries.filter(function (e2) { return e2 !== entry; });
            orphanRows.push({ entry: entry, isLastCopy: others.length === 0, otherCopies: others });
          }
        });
      });
      orphanRows.sort(function (a, b) { return a.entry.path < b.entry.path ? -1 : a.entry.path > b.entry.path ? 1 : 0; });
      return renderOrphans();
    }).catch(function (e) {
      log('Orphan scan failed: ' + e.message, 'err');
    }).then(function () {
      $('orphansProgress').hidden = true;
      btn.disabled = false;
    });
  });

  function renderOrphans() {
    var tbody = $('orphansTbody');
    tbody.innerHTML = '';
    if (orphanRows.length === 0) {
      $('orphansEmpty').hidden = false;
      $('orphansEmpty').textContent = 'No orphaned images found - vault is clean.';
      log('Orphan scan complete - no orphans found', 'ok');
      return Promise.resolve();
    }

    var sizePromises = orphanRows.map(function (row) {
      return row.entry.handle.getFile().then(function (f) { row.size = f.size; }).catch(function () { row.size = null; });
    });

    return Promise.all(sizePromises).then(function () {
      var totalSize = 0;
      orphanRows.forEach(function (row, idx) {
        if (row.size) totalSize += row.size;
        var tr = document.createElement('tr');
        var copiesLabel = row.isLastCopy
          ? '<span class="pill-last">LAST COPY</span>'
          : '<span class="pill-copies">' + (row.otherCopies.length + 1) + ' copies</span>';
        var others = row.otherCopies.map(function (o) { return '<span class="other">other copy: ' + escapeHtml(o.path) + '</span>'; }).join('');
        tr.innerHTML =
          '<td><input type="checkbox" class="orphan-check" data-idx="' + idx + '"></td>' +
          '<td class="path">' + escapeHtml(row.entry.path) + others + '</td>' +
          '<td>' + (row.size != null ? formatBytes(row.size) : '-') + '</td>' +
          '<td>' + copiesLabel + '</td>';
        tbody.appendChild(tr);
      });
      $('orphansSummary').textContent = orphanRows.length + ' orphaned file(s) - ' + formatBytes(totalSize) + ' reclaimable';
      $('orphansResults').hidden = false;
      log('Orphan scan complete - ' + orphanRows.length + ' orphan(s), ' + formatBytes(totalSize) + ' reclaimable', 'ok');
    });
  }

  $('orphansSelectAll').addEventListener('click', function () {
    document.querySelectorAll('.orphan-check').forEach(function (cb) { cb.checked = true; });
  });
  $('orphansSelectNone').addEventListener('click', function () {
    document.querySelectorAll('.orphan-check').forEach(function (cb) { cb.checked = false; });
  });
  $('btnDeleteOrphans').addEventListener('click', function () {
    var selected = [];
    document.querySelectorAll('.orphan-check:checked').forEach(function (cb) {
      selected.push(orphanRows[Number(cb.dataset.idx)]);
    });
    if (selected.length === 0) { log('No orphans selected for deletion.', 'warn'); return; }
    var listHtml = selected.map(function (r) { return escapeHtml(r.entry.path); }).join('<br>');
    confirmModal(
      'Permanently delete ' + selected.length + ' file(s)?',
      'Every file is re-checked for references immediately before deletion, and only recognised image files can ever be removed - notes are never touched.<br><br>This cannot be undone.<div class="targets">' + listHtml + '</div>',
      'Delete permanently'
    ).then(function (ok) {
      if (!ok) return;
      return VO.buildReferenceSets().then(function (sets) {
        var toDelete = [];
        selected.forEach(function (r) {
          var stillReferenced = sets.referencedNames.has(r.entry.name.toLowerCase()) || sets.referencedPaths.has(r.entry.path.toLowerCase());
          if (stillReferenced) {
            log('Skipped delete (now referenced): ' + r.entry.path, 'warn');
          } else {
            toDelete.push(r);
          }
        });
        return Promise.all(toDelete.map(function (r) {
          return VO.safeDeleteImageFile(r.entry).then(function () {
            log('Deleted: ' + r.entry.path, 'ok');
          }).catch(function (e) {
            log('Delete error for ' + r.entry.path + ': ' + e.message, 'err');
          });
        })).then(function () {
          orphanRows = orphanRows.filter(function (r) { return toDelete.indexOf(r) === -1; });
          renderOrphans();
        });
      });
    });
  });

  // ===========================================================================
  // CLEANUP: DUPLICATES
  // ===========================================================================
  var dupGroups = []; // {canonical, redundant: []}

  $('btnScanDuplicates').addEventListener('click', function () {
    var btn = $('btnScanDuplicates');
    btn.disabled = true;
    $('duplicatesEmpty').hidden = true;
    $('duplicatesResults').hidden = true;
    var prog = $('duplicatesProgress');
    prog.hidden = false;
    setProgress('duplicates', 'Building indexes…', 0);

    VO.buildIndexes().then(function () {
      var all = [];
      VO.state.imageIndex.forEach(function (arr) { all = all.concat(arr); });
      var hashMap = new Map();
      var n = all.length;
      var i = 0;

      function hashFile(handle) {
        return handle.getFile().then(function (file) { return file.arrayBuffer(); }).then(function (buf) {
          return crypto.subtle.digest('SHA-256', buf);
        }).then(function (digest) {
          return Array.prototype.map.call(new Uint8Array(digest), function (b) { return b.toString(16).padStart(2, '0'); }).join('');
        });
      }

      function step() {
        if (i >= n) return Promise.resolve();
        var entry = all[i];
        setProgress('duplicates', 'Hashing ' + (i + 1) + ' / ' + n, ((i + 1) / Math.max(n, 1)) * 100);
        return hashFile(entry.handle).then(function (hash) {
          if (!hashMap.has(hash)) hashMap.set(hash, []);
          hashMap.get(hash).push(entry);
          i++;
          return step();
        }).catch(function (e) {
          log('Hash error for ' + entry.path + ': ' + e.message, 'err');
          i++;
          return step();
        });
      }

      return step().then(function () {
        dupGroups = [];
        hashMap.forEach(function (entries) {
          if (entries.length <= 1) return;
          var sorted = entries.slice().sort(function (a, b) {
            var aScore = a.path.toLowerCase().indexOf(VO.ATTACH_FOLDER + '/') !== -1 ? 0 : 1;
            var bScore = b.path.toLowerCase().indexOf(VO.ATTACH_FOLDER + '/') !== -1 ? 0 : 1;
            if (aScore !== bScore) return aScore - bScore;
            if (a.path.length !== b.path.length) return a.path.length - b.path.length;
            return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
          });
          dupGroups.push({ canonical: sorted[0], redundant: sorted.slice(1) });
        });
        renderDuplicates();
      });
    }).catch(function (e) {
      log('Duplicate scan failed: ' + e.message, 'err');
    }).then(function () {
      prog.hidden = true;
      btn.disabled = false;
    });
  });

  function renderDuplicates() {
    var container = $('duplicateGroups');
    container.innerHTML = '';
    if (dupGroups.length === 0) {
      $('duplicatesEmpty').hidden = false;
      $('duplicatesEmpty').textContent = 'No duplicate image content found.';
      log('Duplicate scan complete - no duplicates found', 'ok');
      return;
    }
    var totalRedundant = 0;
    dupGroups.forEach(function (grp, gi) {
      totalRedundant += grp.redundant.length;
      var card = el('div', 'dup-group');
      card.innerHTML = '<div class="keep"><b>Keep</b>' + escapeHtml(grp.canonical.path) + '</div>';
      grp.redundant.forEach(function (r, ri) {
        var row = el('div', 'dup-row');
        row.innerHTML = '<input type="checkbox" class="dup-check" data-g="' + gi + '" data-r="' + ri + '"><span>' + escapeHtml(r.path) + '</span>';
        card.appendChild(row);
      });
      container.appendChild(card);
    });
    $('duplicatesSummary').textContent = dupGroups.length + ' duplicate group(s) - ' + totalRedundant + ' redundant file(s)';
    $('duplicatesResults').hidden = false;
    log('Duplicate scan complete - ' + dupGroups.length + ' group(s), ' + totalRedundant + ' redundant file(s)', 'ok');
  }

  $('dupSelectAllRedundant').addEventListener('click', function () {
    document.querySelectorAll('.dup-check').forEach(function (cb) { cb.checked = true; });
  });
  $('dupSelectNone').addEventListener('click', function () {
    document.querySelectorAll('.dup-check').forEach(function (cb) { cb.checked = false; });
  });
  $('btnDeleteDuplicates').addEventListener('click', function () {
    var selected = [];
    document.querySelectorAll('.dup-check:checked').forEach(function (cb) {
      var g = Number(cb.dataset.g), r = Number(cb.dataset.r);
      selected.push({ g: g, r: r, entry: dupGroups[g].redundant[r] });
    });
    if (selected.length === 0) { log('No duplicate files selected for deletion.', 'warn'); return; }
    var listHtml = selected.map(function (s) { return escapeHtml(s.entry.path); }).join('<br>');
    confirmModal(
      'Permanently delete ' + selected.length + ' file(s)?',
      'Every file is re-checked for references immediately before deletion, and only recognised image files can ever be removed - notes are never touched.<br><br>This cannot be undone.<div class="targets">' + listHtml + '</div>',
      'Delete permanently'
    ).then(function (ok) {
      if (!ok) return;
      return VO.buildReferenceSets().then(function (sets) {
        var toDelete = [];
        selected.forEach(function (s) {
          var stillReferenced = sets.referencedNames.has(s.entry.name.toLowerCase()) || sets.referencedPaths.has(s.entry.path.toLowerCase());
          if (stillReferenced) {
            log('Skipped delete (now referenced): ' + s.entry.path, 'warn');
          } else {
            toDelete.push(s);
          }
        });
        return Promise.all(toDelete.map(function (s) {
          return VO.safeDeleteImageFile(s.entry).then(function () {
            log('Deleted: ' + s.entry.path, 'ok');
          }).catch(function (e) {
            log('Delete error for ' + s.entry.path + ': ' + e.message, 'err');
          });
        })).then(function () {
          var removedKeys = {};
          toDelete.forEach(function (s) { removedKeys[s.g + ':' + s.r] = true; });
          dupGroups.forEach(function (grp, gi) {
            grp.redundant = grp.redundant.filter(function (_, ri) { return !removedKeys[gi + ':' + ri]; });
          });
          dupGroups = dupGroups.filter(function (grp) { return grp.redundant.length > 0; });
          renderDuplicates();
        });
      });
    });
  });

  // ===========================================================================
  // CLEANUP: EMPTY FOLDERS (structure cleanup)
  // Folders that contain nothing (recursively) - no files, only other empty
  // folders. System folders (.git, .obsidian, the backup folder) are never
  // considered, and only a folder is ever removed, never a file.
  // ===========================================================================
  var emptyFolderRows = []; // {path, name, handle, parentHandle}

  $('btnScanEmptyFolders').addEventListener('click', function () {
    var btn = $('btnScanEmptyFolders');
    btn.disabled = true;
    $('emptyFoldersEmpty').hidden = true;
    $('emptyFoldersResults').hidden = true;
    $('emptyFoldersProgress').hidden = false;
    $('emptyFoldersProgressText').textContent = 'Building indexes…';

    VO.buildIndexes().then(function () {
      $('emptyFoldersProgressText').textContent = 'Checking folder contents…';
      // Deepest-first so a parent can see whether its children are empty.
      var dirs = VO.state.allDirs.slice().sort(function (a, b) { return b.path.split('/').length - a.path.split('/').length; });
      var emptyPaths = {};
      var chain = Promise.resolve();

      function isDirEffectivelyEmpty(d) {
        var iterator = d.handle.entries();
        function step() {
          return iterator.next().then(function (res) {
            if (res.done) return true;
            var name = res.value[0];
            var kind = res.value[1].kind;
            if (kind === 'file') return false;
            var childPath = d.path + '/' + name;
            if (emptyPaths[childPath]) return step();
            return false;
          });
        }
        return step();
      }

      dirs.forEach(function (d) {
        chain = chain.then(function () {
          return isDirEffectivelyEmpty(d).then(function (isEmpty) {
            if (isEmpty) emptyPaths[d.path] = d;
          });
        });
      });

      return chain.then(function () {
        emptyFolderRows = Object.keys(emptyPaths).map(function (p) { return emptyPaths[p]; })
          .sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
        renderEmptyFolders();
      });
    }).catch(function (e) {
      log('Empty folder scan failed: ' + e.message, 'err');
    }).then(function () {
      $('emptyFoldersProgress').hidden = true;
      btn.disabled = false;
    });
  });

  function renderEmptyFolders() {
    var container = $('emptyFoldersList');
    container.innerHTML = '';
    if (emptyFolderRows.length === 0) {
      $('emptyFoldersEmpty').hidden = false;
      $('emptyFoldersEmpty').textContent = 'No empty folders found - structure is clean.';
      log('Empty folder scan complete - none found', 'ok');
      return;
    }
    emptyFolderRows.forEach(function (d, idx) {
      var row = el('div', 'folder-row');
      row.innerHTML = '<input type="checkbox" class="folder-check" data-idx="' + idx + '" checked><span>' + escapeHtml(d.path) + '/</span>';
      container.appendChild(row);
    });
    $('emptyFoldersSummary').textContent = emptyFolderRows.length + ' empty folder(s)';
    $('emptyFoldersResults').hidden = false;
    log('Empty folder scan complete - ' + emptyFolderRows.length + ' found', 'ok');
  }

  $('emptyFoldersSelectAll').addEventListener('click', function () {
    document.querySelectorAll('.folder-check').forEach(function (cb) { cb.checked = true; });
  });
  $('emptyFoldersSelectNone').addEventListener('click', function () {
    document.querySelectorAll('.folder-check').forEach(function (cb) { cb.checked = false; });
  });
  $('btnDeleteEmptyFolders').addEventListener('click', function () {
    var selected = [];
    document.querySelectorAll('.folder-check:checked').forEach(function (cb) {
      selected.push(emptyFolderRows[Number(cb.dataset.idx)]);
    });
    if (selected.length === 0) { log('No empty folders selected.', 'warn'); return; }
    // delete deepest-first so a parent's removeEntry sees an empty dir
    selected.sort(function (a, b) { return b.path.split('/').length - a.path.split('/').length; });
    var listHtml = selected.map(function (d) { return escapeHtml(d.path) + '/'; }).join('<br>');
    confirmModal(
      'Permanently delete ' + selected.length + ' empty folder(s)?',
      'Only folders confirmed to contain nothing (recursively - no notes, no images, no other files) are listed. This cannot be undone.<div class="targets">' + listHtml + '</div>',
      'Delete permanently'
    ).then(function (ok) {
      if (!ok) return;
      var chain = Promise.resolve();
      selected.forEach(function (d) {
        chain = chain.then(function () {
          return d.parentHandle.removeEntry(d.name, { recursive: false }).then(function () {
            log('Removed empty folder: ' + d.path, 'ok');
          }).catch(function (e) {
            log('Could not remove ' + d.path + ': ' + e.message, 'err');
          });
        });
      });
      chain.then(function () {
        var removed = new Set(selected.map(function (d) { return d.path; }));
        emptyFolderRows = emptyFolderRows.filter(function (d) { return !removed.has(d.path); });
        renderEmptyFolders();
      });
    });
  });

})();
