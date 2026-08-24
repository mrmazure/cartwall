/**
 * RadioTools – CartWall  |  app.js
 * Consolidated single-file application
 *
 * Sections:
 *  1. Constants & Utilities
 *  2. Layout
 *  3. Audio Engine
 *  4. File Utilities
 *  5. Context Menu
 *  6. Palette Config (Save / Load)
 *  7. Contrôle à distance (PeerJS)
 *  8. Bootstrap / Main
 */

'use strict';

/* =============================================================
   1. CONSTANTS & UTILITIES
   ============================================================= */

const NB_CARTS = 25;
const FADE_MS = 500;
const GAP = 10;

/** Swatch palette for cart color picker */
const SWATCHES = [
  '#374151', // default grey
  '#164e63', // cyan-dark
  '#1e3a5f', // blue-dark
  '#312e81', // indigo-dark
  '#4c1d95', // violet-dark
  '#701a75', // fuchsia-dark
  '#7f1d1d', // red-dark
  '#78350f', // amber-dark
  '#14532d', // green-dark
  '#134e4a', // teal-dark
  // lighter accents
  '#10b981', // emerald
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
];

/** Cart accent colours for left-border highlight */
const ACCENT_COLORS = {
  '#164e63': '#06b6d4',
  '#1e3a5f': '#3b82f6',
  '#312e81': '#818cf8',
  '#4c1d95': '#a78bfa',
  '#701a75': '#e879f9',
  '#7f1d1d': '#f87171',
  '#78350f': '#fbbf24',
  '#14532d': '#34d399',
  '#134e4a': '#2dd4bf',
  '#10b981': '#10b981',
  '#3b82f6': '#3b82f6',
  '#8b5cf6': '#8b5cf6',
  '#f59e0b': '#f59e0b',
  '#ef4444': '#ef4444',
  '#ec4899': '#ec4899',
};

/**
 * Convert seconds to M:SS string
 * @param {number} s
 * @returns {string}
 */
function formatTime(s) {
  if (!isFinite(s)) return '--:--';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

/* =============================================================
   2. LAYOUT
   ============================================================= */

function resizeCarts() {
  const header = document.querySelector('header');
  const gridEl = document.getElementById('grid');
  const rows = 5;
  const available = window.innerHeight - header.offsetHeight - (rows + 1) * GAP;
  const h = Math.max(80, Math.floor(available / rows));
  document.documentElement.style.setProperty('--cart-h', `${h}px`);
}

window.addEventListener('resize', resizeCarts);

/* =============================================================
   3. AUDIO ENGINE
   ============================================================= */

/* ---------------------------------------------------------------
   3a. SHARED AUDIO CONTEXT (pour boucle sans coupure)
   --------------------------------------------------------------- */

let _sharedAudioCtx = null;

function getAudioCtx() {
  if (!_sharedAudioCtx || _sharedAudioCtx.state === 'closed') {
    _sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (_sharedAudioCtx.state === 'suspended') _sharedAudioCtx.resume();
  return _sharedAudioCtx;
}

/**
 * Retourne les bornes de boucle (loopStart, loopEnd, loopLen) en secondes
 * pour un cart donné, en tenant compte des points de cue.
 */
function _glBounds(cartEl) {
  const dur = cartEl.audioBuffer ? cartEl.audioBuffer.duration : (cartEl.audio.duration || 0);
  const ls  = (cartEl.cueIn  !== null) ? cartEl.cueIn  * dur : 0;
  const le  = (cartEl.cueOut !== null) ? cartEl.cueOut * dur : dur;
  return { ls, le, ll: Math.max(0.001, le - ls) };
}

/**
 * Position de lecture actuelle (en secondes depuis le début du buffer)
 * pour un cart en mode gapless-loop. Retourne audio.currentTime sinon.
 */
function glCurrentTime(cartEl) {
  if (!cartEl._glActive) return cartEl.audio.currentTime;
  const ctx = getAudioCtx();
  const { ls, ll } = _glBounds(cartEl);
  const elapsed = ctx.currentTime - cartEl._glStartCtxTime;
  return ls + (elapsed % ll);
}

/**
 * Démarre (ou reprend) la boucle gapless sur un cart.
 * Retourne false si le buffer n'est pas encore prêt (fallback natif).
 */
function startGaplessLoop(cartEl) {
  const buf = cartEl.audioBuffer;
  if (!buf) return false;

  const ctx = getAudioCtx();
  const { ls, le } = _glBounds(cartEl);

  // Crée le GainNode et le connecte directement à la sortie (une seule fois)
  if (!cartEl._glGain) {
    cartEl._glGain = ctx.createGain();
    cartEl._glGain.connect(ctx.destination);
    // Routage vers le périphérique de sortie sélectionné (Chrome 110+)
    if (selectedOutputDeviceId && selectedOutputDeviceId !== 'default'
        && typeof ctx.setSinkId === 'function') {
      ctx.setSinkId(selectedOutputDeviceId).catch(() => {});
    }
  }

  cartEl._glGain.gain.cancelScheduledValues(ctx.currentTime);
  cartEl._glGain.gain.setValueAtTime(getCartVolume(cartEl), ctx.currentTime);

  // Crée un nouveau nœud source
  const src = ctx.createBufferSource();
  src.buffer    = buf;
  src.loop      = true;
  src.loopStart = ls;
  src.loopEnd   = le;
  src.connect(cartEl._glGain);

  const offset       = (cartEl._glOffset !== undefined) ? cartEl._glOffset : ls;
  const ctxNow       = ctx.currentTime;
  src.start(ctxNow, offset);

  cartEl._glSource       = src;
  cartEl._glStartCtxTime = ctxNow;
  cartEl._glActive       = true;
  return true;
}

/** Mets la boucle gapless en pause (mémorise la position). */
function pauseGaplessLoop(cartEl) {
  if (!cartEl._glActive) return;
  cartEl._glOffset = glCurrentTime(cartEl);
  try { cartEl._glSource.stop(); } catch (_) {}
  cartEl._glSource.disconnect();
  cartEl._glSource = null;
  cartEl._glActive = false;
}

/** Arrête la boucle gapless et remet la position au cue-in. */
function stopGaplessLoop(cartEl) {
  if (cartEl._glSource) {
    try { cartEl._glSource.stop(); } catch (_) {}
    cartEl._glSource.disconnect();
    cartEl._glSource = null;
  }
  const { ls } = _glBounds(cartEl);
  cartEl._glOffset = ls;
  cartEl._glActive = false;
}

/** Fade-out du GainNode gapless sur FADE_MS ms, puis appelle cb. */
function fadeOutGaplessLoop(cartEl, cb) {
  const ctx = getAudioCtx();
  const g   = cartEl._glGain.gain;
  g.cancelScheduledValues(ctx.currentTime);
  g.setValueAtTime(g.value, ctx.currentTime);
  g.linearRampToValueAtTime(0, ctx.currentTime + FADE_MS / 1000);
  setTimeout(cb, FADE_MS);
}

/* ---------------------------------------------------------------
   3b. FADE OUT  (éléments HTMLAudioElement natifs)
   --------------------------------------------------------------- */

/**
 * Fade audio element out over `ms` milliseconds, then call `cb`.
 * @param {HTMLAudioElement} el
 * @param {number} [ms]
 * @param {Function} [cb]
 */
function fadeOut(el, ms = FADE_MS, cb) {
  const step = 50 / ms;
  const id = setInterval(() => {
    if (el.volume - step <= 0) {
      el.volume = 0;
      clearInterval(id);
      cb && cb();
    } else {
      el.volume -= step;
    }
  }, 50);
}

/* ---------------------------------------------------------------
   3c. VOLUME PAR CARTOUCHE
   --------------------------------------------------------------- */

/**
 * Retourne le volume utilisateur (0-1) d'une cartouche (1 par défaut).
 * @param {HTMLElement} cartEl
 * @returns {number}
 */
function getCartVolume(cartEl) {
  return (typeof cartEl.userVolume === 'number') ? cartEl.userVolume : 1;
}

/**
 * Définit le volume utilisateur d'une cartouche et l'applique en direct
 * (élément audio natif ou boucle gapless) si elle est en lecture.
 * @param {HTMLElement} cartEl
 * @param {number} vol  Volume cible (0-1)
 */
function setCartVolume(cartEl, vol) {
  vol = Math.max(0, Math.min(1, vol));
  cartEl.userVolume = vol;
  // Application en direct sur le chemin audio actif
  if (cartEl._glActive && cartEl._glGain) {
    const ctx = getAudioCtx();
    cartEl._glGain.gain.cancelScheduledValues(ctx.currentTime);
    cartEl._glGain.gain.setValueAtTime(vol, ctx.currentTime);
  } else if (!cartEl.audio.paused) {
    cartEl.audio.volume = vol;
  }
  scheduleAutoSave();
}

/**
 * Play, pause or reset a cart on click.
 * @param {HTMLElement} cartEl
 */
function playPauseOrReset(cartEl) {
  const audio      = cartEl.audio;
  const mixMode    = document.getElementById('mixMode').checked;
  const resetOn2nd = document.getElementById('secondModeCheckbox').checked;
  const isPlaying  = !audio.paused || cartEl._glActive;

  if (!isPlaying) {
    // === DÉMARRAGE ===
    if (!mixMode) stopAllExcept(cartEl);
    if (audio.loop && cartEl.audioBuffer) {
      // Boucle gapless via Web Audio API
      startGaplessLoop(cartEl);
    } else {
      // Lecture native HTMLAudioElement
      if (cartEl.cueIn !== null && audio.duration) {
        const cueInTime = cartEl.cueIn * audio.duration;
        if (audio.currentTime < cueInTime) audio.currentTime = cueInTime;
      }
      audio.volume = getCartVolume(cartEl);
      audio.play();
    }
    cartEl.classList.add('playing');
    trackProgress(cartEl);
    broadcastCartAction(cartEl.dataset.idx, 'play');
  } else if (resetOn2nd) {
    // === STOP / RESET ===
    broadcastCartAction(cartEl.dataset.idx, 'stop');
    if (cartEl._glActive) {
      fadeOutGaplessLoop(cartEl, () => {
        stopGaplessLoop(cartEl);
        cartEl.classList.remove('playing', 'blinking');
        restoreCartLED(cartEl);
        resetProgress(cartEl);
        broadcastState(cartEl.dataset.idx, false, 0, cartEl.querySelector('.time').textContent, cartEl.style.background || '');
      });
    } else {
      fadeOut(audio, FADE_MS, () => {
        audio.pause();
        const dur = audio.duration || 0;
        audio.currentTime = (cartEl.cueIn !== null && dur) ? cartEl.cueIn * dur : 0;
        cartEl.classList.remove('playing', 'blinking');
        restoreCartLED(cartEl);
        resetProgress(cartEl);
        broadcastState(cartEl.dataset.idx, false, 0, cartEl.querySelector('.time').textContent, cartEl.style.background || '');
      });
    }
  } else {
    // === PAUSE ===
    if (cartEl._glActive) {
      fadeOutGaplessLoop(cartEl, () => {
        pauseGaplessLoop(cartEl);
        cartEl.classList.remove('playing', 'blinking');
        restoreCartLED(cartEl);
      });
    } else {
      fadeOut(audio, FADE_MS, () => {
        audio.pause();
        cartEl.classList.remove('playing', 'blinking');
        restoreCartLED(cartEl);
      });
    }
    broadcastCartAction(cartEl.dataset.idx, 'pause');
  }
}

/**
 * Stop (fade out) all playing carts except the given one.
 * @param {HTMLElement} [except]
 */
function stopAllExcept(except) {
  const resetOn2nd = document.getElementById('secondModeCheckbox').checked;
  document.querySelectorAll('.cart.playing').forEach(c => {
    if (c !== except) {
      if (c._glActive) {
        fadeOutGaplessLoop(c, () => {
          if (resetOn2nd) { stopGaplessLoop(c); resetProgress(c); }
          else pauseGaplessLoop(c);
          c.classList.remove('playing', 'blinking');
          restoreCartLED(c);
        });
      } else {
        fadeOut(c.audio, FADE_MS, () => {
          c.audio.pause();
          if (resetOn2nd) {
            const dur2 = c.audio.duration || 0;
            c.audio.currentTime = (c.cueIn !== null && dur2) ? c.cueIn * dur2 : 0;
            resetProgress(c);
          }
          c.classList.remove('playing', 'blinking');
          restoreCartLED(c);
        });
      }
    }
  });
}

/** Stop and reset all playing carts. */
function stopAll() {
  document.querySelectorAll('.cart.playing').forEach(c => {
    if (c._glActive) {
      fadeOutGaplessLoop(c, () => {
        stopGaplessLoop(c);
        c.classList.remove('playing', 'blinking');
        restoreCartLED(c);
        resetProgress(c);
        broadcastState(+c.dataset.idx, false, 0, c.querySelector('.time').textContent, c.style.background || '');
      });
    } else {
      const dur = c.audio.duration || 0;
      fadeOut(c.audio, FADE_MS, () => {
        c.audio.pause();
        c.audio.currentTime = (c.cueIn !== null && dur) ? c.cueIn * dur : 0;
        c.classList.remove('playing', 'blinking');
        restoreCartLED(c);
        resetProgress(c);
        broadcastState(+c.dataset.idx, false, 0, c.querySelector('.time').textContent, c.style.background || '');
      });
    }
  });
  broadcastCartAction(-1, 'stopAll');
}

/**
 * Track progress of a playing cart via rAF.
 * @param {HTMLElement} cartEl
 */
function trackProgress(cartEl) {
  const audio = cartEl.audio;
  const progEl = cartEl.querySelector('.progress');
  const timeEl = cartEl.querySelector('.time');
  let lastBroadcastMs = 0;
  let ledBlinkState = null; // null=static, true=LED on, false=LED off

  function tick() {
    // En mode gapless, audio.paused est toujours true → on vérifie _glActive
    if (!cartEl._glActive && audio.paused) return;
    const dur = cartEl._glActive
      ? (cartEl.audioBuffer ? cartEl.audioBuffer.duration : getCartDuration(cartEl))
      : getCartDuration(cartEl);
    const currentTime = cartEl._glActive ? glCurrentTime(cartEl) : audio.currentTime;
    if (dur) {
      const cueInTime  = (cartEl.cueIn  !== null) ? cartEl.cueIn  * dur : 0;
      const cueOutTime = (cartEl.cueOut !== null) ? cartEl.cueOut * dur : dur;
      const rangeLen   = Math.max(0.001, cueOutTime - cueInTime);
      const rem        = Math.max(0, cueOutTime - currentTime);
      const pct        = Math.max(0, Math.min(100,
        (currentTime - cueInTime) / rangeLen * 100
      )).toFixed(2);
      progEl.style.width = pct + '%';
      const timeText = '-' + formatTime(rem);
      timeEl.textContent = timeText;
      // Pas de clignotement en boucle gapless (rem se remet à zéro à chaque cycle)
      const shouldBlink = !cartEl._glActive && rem <= 5;
      cartEl.classList.toggle('blinking', shouldBlink);

      // Mirror blink to Launchpad LED
      if (cartEl.midiNote && midiOutput) {
        if (shouldBlink) {
          const blinkOn = Math.floor(Date.now() / 500) % 2 === 0;
          if (blinkOn !== ledBlinkState) {
            ledBlinkState = blinkOn;
            if (blinkOn) setLaunchpadLED(cartEl.midiNote.note, cartEl.style.background || '#ffffff');
            else clearLaunchpadLED(cartEl.midiNote.note);
          }
        } else if (ledBlinkState !== null) {
          ledBlinkState = null;
          setLaunchpadLED(cartEl.midiNote.note, cartEl.style.background || '#ffffff');
        }
      }

      // Broadcast at most every 100ms
      const now = Date.now();
      if (now - lastBroadcastMs >= 100) {
        lastBroadcastMs = now;
        broadcastState(
          cartEl.dataset.idx,
          true,
          parseFloat(pct),
          timeText,
          cartEl.style.background || ''
        );
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

/** Restore a cart's Launchpad LED to its static assigned colour. */
function restoreCartLED(cart) {
  if (cart.midiNote && midiOutput) {
    setLaunchpadLED(cart.midiNote.note, cart.style.background || '#ffffff');
  }
}

/**
 * Durée effective d'un cart, en secondes.
 * `audio.duration` peut rester NaN tant que 'loadedmetadata' n'a pas été
 * déclenché : on retombe alors sur le buffer décodé par generateWaveform().
 * @param {HTMLElement} cartEl
 * @returns {number} 0 si aucune durée n'est encore connue
 */
function getCartDuration(cartEl) {
  const d = cartEl.audio ? cartEl.audio.duration : NaN;
  if (isFinite(d) && d > 0) return d;
  const buf = cartEl.audioBuffer;
  return (buf && isFinite(buf.duration)) ? buf.duration : 0;
}

/**
 * (Ré)affiche la durée — ou celle du segment cue — sur un cart à l'arrêt.
 * @param {HTMLElement} cartEl
 */
function refreshCartTime(cartEl) {
  const timeEl = cartEl.querySelector('.time');
  const dur = getCartDuration(cartEl);
  if (!dur) { timeEl.textContent = ''; return; }
  const inP  = cartEl.cueIn  ?? 0;
  const outP = cartEl.cueOut ?? 1;
  const displayDur = (cartEl.cueIn !== null || cartEl.cueOut !== null)
    ? (outP - inP) * dur : dur;
  timeEl.textContent = formatTime(Math.max(0, displayDur));
}

/**
 * Reset progress bar and time display of a cart.
 * @param {HTMLElement} cartEl
 */
function resetProgress(cartEl) {
  cartEl.querySelector('.progress').style.width = '0%';
  refreshCartTime(cartEl);
}

/* =============================================================
   4. FILE UTILITIES
   ============================================================= */

/**
 * Open the hidden file picker and call `cb` with the selected File.
 * @param {function(File):void} cb
 */
function pickFile(cb) {
  const picker = document.getElementById('filePicker');
  picker.value = '';
  picker.onchange = () => {
    const f = picker.files[0];
    if (f) cb(f);
  };
  picker.click();
}

/**
 * Assign an audio file to a cart element.
 * @param {HTMLElement} cartEl
 * @param {File} file
 * @param {boolean} [keepLabel=false] Conserve le libellé actuel (restauration
 *        d'une config : le nom personnalisé prime sur le nom de fichier).
 */
function assignFile(cartEl, file, keepLabel = false) {
  cartEl.file = file;
  cartEl.classList.remove('empty');
  if (cartEl.objectURL) URL.revokeObjectURL(cartEl.objectURL);
  cartEl.objectURL = URL.createObjectURL(file);

  // Libellé et persistance immédiats : ils ne doivent pas dépendre de
  // 'loadedmetadata', qui peut tarder — voire ne jamais arriver — au premier
  // chargement de la page.
  if (!keepLabel) {
    cartEl.querySelector('.label').textContent = file.name.replace(/\.[^.]+$/, '');
  }

  // Invalidate cached waveform/buffer and regenerate asynchronously
  cartEl.waveformData  = null;
  cartEl.audioBuffer   = null;

  // Applique la sortie audio sélectionnée AVANT de lancer le chargement, pour
  // ne pas interrompre la sélection de ressource de l'élément audio.
  if (selectedOutputDeviceId && 'setSinkId' in HTMLAudioElement.prototype) {
    cartEl.audio.setSinkId(selectedOutputDeviceId).catch(() => {});
  }
  cartEl.audio.src = cartEl.objectURL;
  cartEl.audio.load();      // force la lecture des métadonnées (durée)

  refreshCartTime(cartEl);  // efface l'affichage précédent en attendant

  generateWaveform(file).then(({ waveform, audioBuffer }) => {
    if (cartEl.file !== file) return;
    cartEl.waveformData = waveform;
    cartEl.audioBuffer  = audioBuffer;
    // Filet de sécurité : si 'loadedmetadata' n'a pas encore fourni de durée,
    // on affiche celle du buffer décodé.
    if (cartEl.audio.paused && !cartEl._glActive) refreshCartTime(cartEl);
    broadcastCartMeta(cartEl);
  });

  broadcastCartMeta(cartEl); // sync label, color, duration to slaves
  scheduleAutoSave();
}

/**
 * Clear a cart: stop audio, remove file reference, reset UI.
 * @param {HTMLElement} cartEl
 */
function clearCart(cartEl) {
  // Arrêt de la boucle gapless si active
  if (cartEl._glActive) stopGaplessLoop(cartEl);
  if (cartEl._glSource) { try { cartEl._glSource.stop(); } catch(_) {} cartEl._glSource = null; }
  if (cartEl._glGain)   { cartEl._glGain.disconnect(); cartEl._glGain = null; }
  cartEl._glOffset = undefined;
  cartEl.audioBuffer = null;

  if (cartEl.objectURL) URL.revokeObjectURL(cartEl.objectURL);
  delete cartEl.file;
  cartEl.audio.pause();
  cartEl.audio.src = '';
  cartEl.objectURL = null;
  cartEl.waveformData = null;
  cartEl.cueIn  = null;
  cartEl.cueOut = null;
  cartEl.userVolume = 1;
  cartEl.classList.remove('playing', 'blinking', 'loop');
  cartEl.classList.add('empty');
  const idx = +cartEl.dataset.idx;
  cartEl.querySelector('.label').textContent = `Cartouche ${idx + 1}`;
  cartEl.querySelector('.time').textContent = '';
  cartEl.querySelector('.progress').style.width = '0%';
  cartEl.style.background = '';
  updateCueBadge(cartEl);
  scheduleAutoSave();
}

/** Clear all carts after user confirmation. */
function clearAllFiles() {
  if (confirm('Confirmer la suppression de tous les fichiers et couleurs ?')) {
    document.querySelectorAll('.cart').forEach(clearCart);
    if (typeof clearAllLaunchpadLEDs === 'function') {
      clearAllLaunchpadLEDs();
    }
  }
}

/* =============================================================
   5. CONTEXT MENU
   ============================================================= */

function buildContextMenu(cartEl) {
  const menu = document.getElementById('ctxMenu');
  menu.innerHTML = '';

  // Swatch row
  const swatchRow = document.createElement('div');
  swatchRow.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:4px;';
  SWATCHES.forEach(hex => {
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = hex;
    // The browser normalises both values to the same rgb() form → reliable compare
    const isActive = !!(cartEl && cartEl.style.background &&
                        cartEl.style.background === sw.style.background);
    if (isActive) sw.classList.add('active');
    sw.title = isActive ? `${hex} — cliquer pour retirer` : hex;
    sw.onclick = () => {
      if (cartEl) {
        if (cartEl.style.background === sw.style.background) {
          // Re-click on the active colour → revert to base colour
          cartEl.style.background = '';
          if (cartEl.midiNote) setLaunchpadLED(cartEl.midiNote.note, '#ffffff');
        } else {
          cartEl.style.background = hex;
          if (cartEl.midiNote) setLaunchpadLED(cartEl.midiNote.note, hex);
        }
        broadcastCartMeta(cartEl); // sync color change live
        scheduleAutoSave();
      }
      hideCtxMenu();
    };
    swatchRow.appendChild(sw);
  });
  menu.appendChild(swatchRow);

  // Volume slider
  const volRow = document.createElement('div');
  volRow.className = 'ctx-volume';
  const volPct = Math.round(getCartVolume(cartEl) * 100);
  volRow.innerHTML = `
    <span class="ctx-volume-ico">🔊</span>
    <input class="ctx-volume-slider" type="range" min="0" max="100" value="${volPct}"
           aria-label="Volume de la cartouche" />
    <span class="ctx-volume-val">${volPct}%</span>`;
  const volSlider = volRow.querySelector('.ctx-volume-slider');
  const volVal    = volRow.querySelector('.ctx-volume-val');
  volSlider.oninput = () => {
    if (cartEl) setCartVolume(cartEl, +volSlider.value / 100);
    volVal.textContent = `${volSlider.value}%`;
  };
  menu.appendChild(volRow);

  // Add file button
  const btnFile = document.createElement('button');
  btnFile.textContent = '🎵 Ajouter un fichier…';
  btnFile.onclick = () => {
    if (cartEl) pickFile(f => assignFile(cartEl, f));
    hideCtxMenu();
  };
  menu.appendChild(btnFile);

  // Rename label
  const btnRename = document.createElement('button');
  btnRename.textContent = '✏️ Renommer…';
  btnRename.onclick = () => {
    if (cartEl) {
      const current = cartEl.querySelector('.label').textContent;
      const next = prompt('Nouveau nom :', current);
      if (next !== null && next.trim()) {
        cartEl.querySelector('.label').textContent = next.trim();
        broadcastCartMeta(cartEl); // sync label change live
        scheduleAutoSave();
      }
    }
    hideCtxMenu();
  };
  menu.appendChild(btnRename);

  // Clear cart
  const btnClear = document.createElement('button');
  btnClear.textContent = '❌ Vider la cartouche';
  btnClear.onclick = () => {
    if (cartEl) clearCart(cartEl);
    hideCtxMenu();
  };
  menu.appendChild(btnClear);

  // Loop toggle
  const isLoop = cartEl && cartEl.audio.loop;
  const btnLoop = document.createElement('button');
  btnLoop.textContent = isLoop ? '🔁 Désactiver boucle' : '🔁 Activer boucle';
  if (isLoop) btnLoop.classList.add('active');
  btnLoop.onclick = () => {
    if (cartEl) {
      const wasGapless = cartEl._glActive;
      cartEl.audio.loop = !cartEl.audio.loop;
      cartEl.classList.toggle('loop', cartEl.audio.loop);

      // Si on désactive la boucle pendant une lecture gapless, bascule en natif
      if (wasGapless && !cartEl.audio.loop) {
        const pos = glCurrentTime(cartEl);
        fadeOutGaplessLoop(cartEl, () => {
          stopGaplessLoop(cartEl);
          if (cartEl.audio.duration) cartEl.audio.currentTime = pos;
          cartEl.audio.volume = getCartVolume(cartEl);
          cartEl.audio.play();
        });
      }
      scheduleAutoSave();
    }
    hideCtxMenu();
  };
  menu.appendChild(btnLoop);

  // Cue editor — toujours visible, désactivé si aucun fichier sur la cartouche
  const hasFile = !!(cartEl && cartEl.file);
  const hasCue  = hasFile && (cartEl.cueIn !== null || cartEl.cueOut !== null);
  const btnCue  = document.createElement('button');
  btnCue.innerHTML = hasCue
    ? '🎯 Cue… <span style="color:var(--accent);font-size:0.78em;font-weight:700">●</span>'
    : '🎯 Cue…';
  if (hasCue) btnCue.classList.add('active');
  if (!hasFile) {
    btnCue.disabled = true;
    btnCue.style.opacity = '0.4';
    btnCue.style.cursor = 'not-allowed';
  } else {
    btnCue.onclick = () => { hideCtxMenu(); openCueModal(cartEl); };
  }
  menu.appendChild(btnCue);

  // ── Separator ────────────────────────────────────────────
  const sep = document.createElement('hr');
  sep.style.cssText = 'border:none;border-top:1px solid #374151;margin:4px 0;width:100%;';
  menu.appendChild(sep);

  // Keyboard shortcut assignment
  const btnKey = document.createElement('button');
  const scLabel = cartEl && cartEl.shortcut ? ` [${formatShortcut(cartEl.shortcut)}]` : '';
  btnKey.textContent = `⌨️ Raccourci clavier…${scLabel}`;
  if (cartEl && cartEl.shortcut) btnKey.classList.add('active');
  btnKey.onclick = () => { hideCtxMenu(); if (cartEl) startKeyCapture(cartEl); };
  menu.appendChild(btnKey);

  // MIDI assignment
  const btnMidi = document.createElement('button');
  const mLabel = cartEl && cartEl.midiNote
    ? ` [Ch${cartEl.midiNote.channel + 1} N${cartEl.midiNote.note}]`
    : '';
  btnMidi.textContent = `🎹 Commande MIDI…${mLabel}`;
  if (cartEl && cartEl.midiNote) btnMidi.classList.add('active');
  btnMidi.onclick = () => { hideCtxMenu(); if (cartEl) startMidiCapture(cartEl); };
  menu.appendChild(btnMidi);
}

function showCtxMenu(x, y, cartEl) {
  const menu = document.getElementById('ctxMenu');
  menu._target = cartEl;
  buildContextMenu(cartEl);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  menu.style.bottom = 'auto';
  menu.style.display = 'flex';
  menu.style.flexDirection = 'column';

  // Clamp to viewport
  requestAnimationFrame(() => {
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 8}px`;
    if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 8}px`;
  });
}

function showCtxMenuMobile(cartEl) {
  const menu = document.getElementById('ctxMenu');
  menu._target = cartEl;
  buildContextMenu(cartEl);
  menu.style.left = '0';
  menu.style.right = '0';
  menu.style.bottom = '0';
  menu.style.top = 'auto';
  menu.style.width = '100%';
  menu.style.display = 'flex';
  menu.style.flexDirection = 'column';
}

function hideCtxMenu() {
  const menu = document.getElementById('ctxMenu');
  menu.style.display = 'none';
  delete menu._target;
}

document.addEventListener('click', e => {
  const menu = document.getElementById('ctxMenu');
  if (menu && !menu.contains(e.target)) hideCtxMenu();
});

/* =============================================================
   6. PALETTE CONFIG  (Save / Load)
   ============================================================= */

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function dataURLtoBlob(dataURL) {
  const [meta, b64] = dataURL.split(',');
  const mime = meta.match(/:(.*?);/)[1];
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/** Serialize the current palette to a downloadable JSON file. */
async function saveConfig() {
  const carts = Array.from(document.querySelectorAll('.cart'));
  const data = [];

  for (const c of carts) {
    let dataUrl = null;
    if (c.file) dataUrl = await readFileAsDataURL(c.file);
    data.push({
      background: c.style.background || '',
      label: c.querySelector('.label').textContent,
      loop: c.audio.loop,
      shortcut: c.shortcut || null,
      midiNote: c.midiNote || null,
      cueIn:  c.cueIn  ?? null,
      cueOut: c.cueOut ?? null,
      volume: c.userVolume ?? 1,
      dataUrl,
    });
  }

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'cartwall-config.json';
  a.click();
  URL.revokeObjectURL(url);
}

/** Load a saved palette JSON file. */
function loadConfig(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data) || data.length !== NB_CARTS) throw new Error('invalid');
      const carts = document.querySelectorAll('.cart');
      for (let i = 0; i < data.length; i++) {
        const el = carts[i];
        const cfg = data[i];
        el.style.background = cfg.background || '';
        el.querySelector('.label').textContent = cfg.label || `Cartouche ${i + 1}`;
        if (cfg.dataUrl) {
          const blob = dataURLtoBlob(cfg.dataUrl);
          const f = new File([blob], cfg.label, { type: blob.type });
          assignFile(el, f, true); // le libellé vient déjà de la config
        } else {
          clearCart(el);
          el.querySelector('.label').textContent = cfg.label || `Cartouche ${i + 1}`;
        }
        el.audio.loop = !!cfg.loop;
        el.classList.toggle('loop', !!cfg.loop);
        if (cfg.shortcut) { el.shortcut = cfg.shortcut; } else { delete el.shortcut; }
        if (cfg.midiNote) { el.midiNote = cfg.midiNote; } else { delete el.midiNote; }
        el.cueIn  = cfg.cueIn  ?? null;
        el.cueOut = cfg.cueOut ?? null;
        el.userVolume = cfg.volume ?? 1;
        refreshCartTime(el); // les cue points viennent d'être appliqués
        updateShortcutBadge(el);
        updateCueBadge(el);
      }
      if (data.some(cfg => cfg.midiNote) && !midiAccess) await initMidi();
      updateAllLaunchpadLEDs();
    } catch {
      alert(`Fichier invalide — attendu un JSON de ${NB_CARTS} cartouches.`);
    }
  };
  reader.readAsText(file);
  e.target.value = ''; // reset so the same file can be re-selected
}

/* =============================================================
   6b. AUTO-SAVE / AUTO-LOAD (IndexedDB)
   ============================================================= */

/** Open (or create) the autosave IndexedDB. */
function openAutosaveDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('cartwall-autosave', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('config');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

/** Persist current palette to IndexedDB (audio files stored as Blobs). */
async function autoSave() {
  const carts = Array.from(document.querySelectorAll('.cart'));
  const data  = carts.map(c => ({
    background: c.style.background || '',
    label:      c.querySelector('.label').textContent,
    loop:       c.audio.loop,
    shortcut:   c.shortcut  || null,
    midiNote:   c.midiNote  || null,
    cueIn:      c.cueIn     ?? null,
    cueOut:     c.cueOut    ?? null,
    volume:     c.userVolume ?? 1,
    file:       c.file      || null,  // File extends Blob — stored natively
    fileName:   c.file ? c.file.name : null,
    fileType:   c.file ? c.file.type : null,
  }));
  try {
    const db = await openAutosaveDB();
    await new Promise((res, rej) => {
      const tx = db.transaction('config', 'readwrite');
      tx.objectStore('config').put(data, 'latest');
      tx.oncomplete = res;
      tx.onerror    = e => rej(e.target.error);
    });
    db.close();
  } catch (err) {
    console.warn('[CartWall] autosave failed:', err);
  }
}

/** Debounce multiple rapid changes into a single IndexedDB write. */
let _autoSaveTimer = null;
function scheduleAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(autoSave, 600);
}

/** Restore the last saved palette from IndexedDB (called once at startup). */
async function autoLoad() {
  let data;
  try {
    const db = await openAutosaveDB();
    data = await new Promise((res, rej) => {
      const tx  = db.transaction('config', 'readonly');
      const req = tx.objectStore('config').get('latest');
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    });
    db.close();
  } catch (err) {
    console.warn('[CartWall] autoload failed:', err);
    return;
  }
  if (!data || !Array.isArray(data) || data.length !== NB_CARTS) return;

  const carts = document.querySelectorAll('.cart');
  for (let i = 0; i < data.length; i++) {
    const el  = carts[i];
    const cfg = data[i];
    el.style.background = cfg.background || '';
    el.querySelector('.label').textContent = cfg.label || `Cartouche ${i + 1}`;
    el.cueIn  = cfg.cueIn  ?? null;
    el.cueOut = cfg.cueOut ?? null;
    el.userVolume = cfg.volume ?? 1;
    if (cfg.file) {
      const f = new File([cfg.file], cfg.fileName || 'audio', { type: cfg.fileType || '' });
      assignFile(el, f, true); // le libellé vient déjà de la config
    }
    el.audio.loop = !!cfg.loop;
    el.classList.toggle('loop', !!cfg.loop);
    if (cfg.shortcut) { el.shortcut = cfg.shortcut; } else { delete el.shortcut; }
    if (cfg.midiNote) { el.midiNote = cfg.midiNote; } else { delete el.midiNote; }
    updateShortcutBadge(el);
    updateCueBadge(el);
  }
  if (data.some(cfg => cfg.midiNote) && !midiAccess) await initMidi();
  updateAllLaunchpadLEDs();
}

/* =============================================================
   7. CONTRÔLE À DISTANCE (PeerJS)
   ============================================================= */

let peer = null;   // our Peer instance
let hostConn = null;   // client → host connection
let clientConns = [];     // host → clients connections
let isHost = false;
let isClient = false;

/**
 * Generate a random room ID.
 * @returns {string}
 */
function randomRoomId() {
  return 'cw-' + Math.random().toString(36).slice(2, 9);
}

/**
 * Build a snapshot of the current palette (labels, colors) – no audio data.
 * @returns {Array}
 */
function buildPaletteSnapshot() {
  return Array.from(document.querySelectorAll('.cart')).map(c => ({
    idx: +c.dataset.idx,
    label: c.querySelector('.label').textContent,
    background: c.style.background || '',
    hasFile: !!c.file,
    loop: c.audio.loop,
    empty: c.classList.contains('empty'),
  }));
}

/**
 * Apply a palette snapshot received from host (client-side).
 * @param {Array} snapshot
 */
function applyPaletteSnapshot(snapshot) {
  const carts = document.querySelectorAll('.cart');
  snapshot.forEach(cfg => {
    const el = carts[cfg.idx];
    if (!el) return;
    el.querySelector('.label').textContent = cfg.label;
    el.style.background = cfg.background;
    el.classList.toggle('empty', cfg.empty);
    el.classList.toggle('loop', cfg.loop);
  });
}

/**
 * Broadcast cart metadata (label, color, state) to all clients.
 * Called after file assignment, rename, or color change.
 * @param {HTMLElement} cartEl
 */
function broadcastCartMeta(cartEl) {
  if (!isHost || clientConns.length === 0) return;
  const dur = getCartDuration(cartEl);
  const msg = {
    type: 'cartMeta',
    idx: +cartEl.dataset.idx,
    label: cartEl.querySelector('.label').textContent,
    background: cartEl.style.background || '',
    empty: cartEl.classList.contains('empty'),
    loop: cartEl.audio.loop,
    timeText: dur ? formatTime(dur) : '',
  };
  clientConns.forEach(conn => { if (conn.open) conn.send(msg); });
}

/**
 * Broadcast a cart action (play/pause/stop) to all connected clients (remotes).
 * @param {number|string} idx   Cart index or -1 for stopAll
 * @param {string}        action  'play'|'pause'|'stop'|'stopAll'
 */
function broadcastCartAction(idx, action) {
  if (!isHost) return;
  const msg = { type: 'action', idx, action };
  clientConns.forEach(conn => {
    if (conn.open) conn.send(msg);
  });
}

/**
 * Broadcast the visual state of a cart (playing, progress, time, color) to clients.
 * @param {number|string} idx
 * @param {boolean} playing
 * @param {number}  progress   Percentage 0-100
 * @param {string}  timeText   Formatted time string
 * @param {string}  background Cart background color
 */
function broadcastState(idx, playing, progress, timeText, background) {
  if (!isHost || clientConns.length === 0) return;
  const msg = { type: 'state', idx, playing, progress, timeText, background };
  clientConns.forEach(conn => {
    if (conn.open) conn.send(msg);
  });
}

/**
 * Handle a message received by the HOST from a client.
 * @param {object} msg
 */
function onHostReceive(msg) {
  if (msg.type === 'cartClick') {
    const carts = document.querySelectorAll('.cart');
    const cartEl = carts[msg.idx];
    if (cartEl && cartEl.audio.src) playPauseOrReset(cartEl);
    return;
  }
  if (msg.type === 'setting') {
    // Slave toggled Mix or 2nd-click mode — apply on master
    const el = document.getElementById(msg.key);
    if (el) {
      el.checked = msg.value;
      el.dispatchEvent(new Event('change'));
    }
    // Re-broadcast to other clients
    clientConns.forEach(conn => {
      if (conn.open) conn.send(msg);
    });
  }
}

/**
 * Handle a message received by the CLIENT from the host.
 * @param {object} msg
 */
function onClientReceive(msg) {
  const carts = document.querySelectorAll('.cart');

  if (msg.type === 'palette') {
    applyPaletteSnapshot(msg.snapshot);
    // Also apply toggle states if sent
    if (msg.mixMode !== undefined) {
      const el = document.getElementById('mixMode');
      if (el) el.checked = msg.mixMode;
    }
    if (msg.secondMode !== undefined) {
      const el = document.getElementById('secondModeCheckbox');
      if (el) el.checked = msg.secondMode;
    }
    // Close the modal silently
    document.getElementById('collabOverlay').classList.add('hidden');
    return;
  }

  if (msg.type === 'cartMeta') {
    // Live update of label, color, or file state from master
    const el = carts[msg.idx];
    if (!el) return;
    el.querySelector('.label').textContent = msg.label;
    el.style.background = msg.background;
    el.classList.toggle('empty', msg.empty);
    el.classList.toggle('loop', msg.loop);
    if (msg.timeText !== undefined) {
      const timeEl = el.querySelector('.time');
      if (timeEl) timeEl.textContent = msg.timeText;
    }
    return;
  }

  if (msg.type === 'state') {
    const el = carts[msg.idx];
    if (!el) return;
    const prog = el.querySelector('.progress');
    if (prog) prog.style.width = msg.progress + '%';
    el.classList.toggle('playing', msg.playing);
    // Update time display
    if (msg.timeText !== undefined) {
      const timeEl = el.querySelector('.time');
      if (timeEl) timeEl.textContent = msg.timeText;
    }
    // Update background color
    if (msg.background !== undefined) {
      el.style.background = msg.background;
    }
    return;
  }

  if (msg.type === 'action') {
    if (msg.action === 'stopAll') {
      carts.forEach(c => {
        c.classList.remove('playing', 'blinking');
        const prog = c.querySelector('.progress');
        if (prog) prog.style.width = '0%';
      });
      return;
    }
    const el = carts[msg.idx];
    if (!el) return;
    if (msg.action === 'play') {
      el.classList.add('playing');
    } else {
      el.classList.remove('playing', 'blinking');
      if (msg.action === 'stop') {
        const prog = el.querySelector('.progress');
        if (prog) prog.style.width = '0%';
      }
    }
    return;
  }

  if (msg.type === 'setting') {
    // Host broadcast a setting change
    const el = document.getElementById(msg.key);
    if (el) el.checked = msg.value;
  }
}

/**
 * Start as HOST: create a PeerJS instance with the given roomId.
 * @param {string} roomId
 */
function startHost(roomId) {
  isHost = true;
  peer = new Peer(roomId, { debug: 0 });

  peer.on('open', id => {
    console.log('[Contrôle à distance] Host ready, room:', id);
  });

  peer.on('connection', conn => {
    clientConns.push(conn);
    updatePeerCount();

    conn.on('open', () => {
      // Send current palette snapshot + toggle states
      conn.send({
        type: 'palette',
        snapshot: buildPaletteSnapshot(),
        mixMode: document.getElementById('mixMode').checked,
        secondMode: document.getElementById('secondModeCheckbox').checked,
      });
    });

    conn.on('data', msg => onHostReceive(msg));

    conn.on('close', () => {
      clientConns = clientConns.filter(c => c !== conn);
      updatePeerCount();
    });

    conn.on('error', err => {
      console.warn('[Contrôle à distance] Client connection error:', err);
      clientConns = clientConns.filter(c => c !== conn);
      updatePeerCount();
    });
  });

  peer.on('error', err => {
    console.error('[Contrôle à distance] Peer error:', err);
    alert('Erreur PeerJS : ' + err.type);
  });
}

/**
 * Connect as CLIENT to an existing host peer.
 * @param {string} roomId
 */
function startClient(roomId) {
  isClient = true;
  document.body.classList.add('is-client');
  peer = new Peer({ debug: 0 });

  peer.on('open', () => {
    hostConn = peer.connect(roomId, { reliable: true });

    hostConn.on('open', () => {
      console.log('[Contrôle à distance] Connected to host:', roomId);
    });

    hostConn.on('data', msg => onClientReceive(msg));

    hostConn.on('close', () => {
      isClient = false;
      document.body.classList.remove('is-client');
      console.warn('[Contrôle à distance] Connection closed by host.');
    });

    hostConn.on('error', err => {
      console.error('[Contrôle à distance] Connection error:', err);
    });
  });

  peer.on('error', err => {
    console.error('[Contrôle à distance] Peer error:', err);
  });
}

/** Update the peer count display in the host UI. */
function updatePeerCount() {
  const n = clientConns.length;
  document.getElementById('peerCount').textContent =
    n === 0 ? '' : `Collaborateurs : ${n}`;
}

/**
 * Initialize collaboration on page load.
 * Reads ?room=ID from the URL — if found → join as client; modal closes once connected.
 */
function initCollaboration() {
  const params = new URLSearchParams(window.location.search);
  const roomId = params.get('room');
  if (!roomId) return;

  // Mark body as client immediately (hides host-only buttons via CSS)
  document.body.classList.add('is-client');
  isClient = true;

  startClient(roomId);
}

/* =============================================================
   9. KEYBOARD SHORTCUTS & MIDI
   ============================================================= */

// ── State ──────────────────────────────────────────────────────
let midiAccess = null;
let midiOutput = null;      // Detected Launchpad MIDI output
let launchpadType = null;   // 'original' | 'mk2' | 'mk3'
let capturingMidi = null;   // cartEl currently awaiting MIDI assignment

// ── Shortcut helpers ───────────────────────────────────────────

/**
 * Format a stored shortcut object as a human-readable string.
 * @param {{ key: string, ctrl: boolean, alt: boolean, shift: boolean }} sc
 * @returns {string}
 */
function formatShortcut(sc) {
  const parts = [];
  if (sc.ctrl) parts.push('Ctrl');
  if (sc.alt) parts.push('Alt');
  if (sc.shift) parts.push('Shift');
  const k = sc.key;
  parts.push(k.length === 1 ? k.toUpperCase() : k);
  return parts.join('+');
}

/**
 * Create or update the shortcut/MIDI badge on a cart element.
 * @param {HTMLElement} cartEl
 */
function updateShortcutBadge(cartEl) {
  let badge = cartEl.querySelector('.shortcut-badge');
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'shortcut-badge';
    cartEl.appendChild(badge);
  }
  badge.innerHTML = '';
  if (cartEl.shortcut) {
    const span = document.createElement('span');
    span.textContent = `⌨ ${formatShortcut(cartEl.shortcut)}`;
    badge.appendChild(span);
  }
  if (cartEl.midiNote) {
    const span = document.createElement('span');
    span.textContent = `🎹 N${cartEl.midiNote.note}`;
    badge.appendChild(span);
  }
  badge.style.display = (cartEl.shortcut || cartEl.midiNote) ? '' : 'none';
}

/**
 * Build and show a key/MIDI capture overlay modal.
 * @param {string}   message  Text shown in the modal
 * @param {Function} onCancel Called when user clicks Annuler
 * @param {Function} onClear  Called when user clicks Effacer
 * @returns {HTMLElement}     The overlay element (already appended to body)
 */
function createCaptureOverlay(message, onCancel, onClear) {
  document.querySelector('.key-capture-overlay')?.remove();
  const overlay = document.createElement('div');
  overlay.className = 'key-capture-overlay';
  overlay.innerHTML = `
    <div class="key-capture-box">
      <p class="key-capture-msg">${message}</p>
      <div class="key-capture-actions">
        <button class="key-capture-clear">Effacer</button>
        <button class="key-capture-cancel">Annuler</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.key-capture-cancel').onclick = () => { onCancel(); overlay.remove(); };
  overlay.querySelector('.key-capture-clear').onclick = () => { onClear(); overlay.remove(); };
  return overlay;
}

// ── Keyboard Capture ───────────────────────────────────────────

/**
 * Open a key-capture overlay and assign the pressed key to a cart.
 * @param {HTMLElement} cartEl
 */
function startKeyCapture(cartEl) {
  const overlay = createCaptureOverlay(
    '⌨️ Appuyez sur une touche…',
    () => document.removeEventListener('keydown', capture, true),
    () => {
      document.removeEventListener('keydown', capture, true);
      delete cartEl.shortcut;
      updateShortcutBadge(cartEl);
    }
  );

  function capture(e) {
    if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key !== 'Escape') {
      cartEl.shortcut = {
        key: e.key,
        code: e.code,
        ctrl: e.ctrlKey,
        alt: e.altKey,
        shift: e.shiftKey,
      };
      updateShortcutBadge(cartEl);
      scheduleAutoSave();
    }
    document.removeEventListener('keydown', capture, true);
    overlay.remove();
  }
  document.addEventListener('keydown', capture, true);
}

// ── Global keyboard trigger ────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.matches('input, textarea, select')) return;
  if (document.querySelector('.key-capture-overlay')) return;
  document.querySelectorAll('.cart').forEach(cart => {
    const sc = cart.shortcut;
    if (!sc) return;
    if (
      sc.code === e.code &&
      sc.ctrl === e.ctrlKey &&
      sc.alt === e.altKey &&
      sc.shift === e.shiftKey
    ) {
      e.preventDefault();
      if (isClient) {
        if (hostConn && hostConn.open) hostConn.send({ type: 'cartClick', idx: +cart.dataset.idx });
      } else if (cart.audio.src) {
        playPauseOrReset(cart);
      }
    }
  });
});

// ── MIDI Engine ────────────────────────────────────────────────

/**
 * Initialize the Web MIDI API and detect connected devices.
 * @returns {Promise<void>}
 */
async function initMidi() {
  if (!navigator.requestMIDIAccess) {
    console.info('[MIDI] Web MIDI API non disponible sur ce navigateur.');
    return;
  }
  try {
    midiAccess = await navigator.requestMIDIAccess({ sysex: true });
    midiAccess.inputs.forEach(inp => { inp.onmidimessage = onMidiMessage; });
    midiAccess.onstatechange = async () => {
      midiAccess.inputs.forEach(inp => { inp.onmidimessage = onMidiMessage; });
      await detectLaunchpad();
      updateAllLaunchpadLEDs();
    };
    await detectLaunchpad();
    updateAllLaunchpadLEDs();
  } catch (err) {
    console.warn('[MIDI] Accès refusé :', err);
  }
}

/** Return true if the MIDI output name looks like a Novation Launchpad. */
function isLaunchpadOutput(name) {
  const n = name.toLowerCase();
  return n.includes('launchpad') || n.includes('lpminimk3') || n.includes('lpmk2') ||
    n.includes('lpmk3') || n.includes('lpx ') || n.includes('lpprox');
}

/** Scan MIDI outputs to find a Launchpad device and classify its generation. */
async function detectLaunchpad() {
  midiOutput = null;
  launchpadType = null;

  // Log all outputs to help diagnose detection issues
  console.info('[MIDI] Sorties MIDI disponibles :',
    [...midiAccess.outputs.values()].map(o => o.name));

  // Prefer Port 1 (first matching output) — SysEx LED commands must go to Port 1
  midiAccess.outputs.forEach(out => {
    if (isLaunchpadOutput(out.name) && !midiOutput) midiOutput = out;
  });
  if (!midiOutput) return;

  const n = midiOutput.name.toLowerCase();
  if (n.includes('mk2') || n.includes('lpmk2')) {
    launchpadType = 'mk2';
  } else if (n.includes('mk3') || n.includes('lpminimk3') || n.includes('lpmk3') ||
    n.includes('launchpad x') || n.includes('lpx ') || n.includes('pro 3')) {
    launchpadType = 'mk3';
    enterProgrammerMode();
    // Give the device ~100 ms to switch to Programmer Mode before sending LEDs
    await new Promise(r => setTimeout(r, 100));
  } else {
    launchpadType = 'original'; // Launchpad S, Mini 1st gen, original
  }
  console.info(`[MIDI] Launchpad détecté : "${midiOutput.name}" (type: ${launchpadType})`);

  // Clear all LEDs initially
  clearAllLaunchpadLEDs();
}

/**
 * Send "Enter Programmer Mode" SysEx to Launchpad MK3 family.
 * Two methods sent back-to-back for firmware compatibility:
 *   - Mode Select (0x0E 0x01): standard MK3/X/Pro Programmer Mode
 *   - Layout Select 0x7F: some Mini MK3 firmware versions need this
 */
function enterProgrammerMode() {
  const prod = getLaunchpadProductByte();
  if (!prod || !midiOutput) return;
  try {
    midiOutput.send([0xF0, 0x00, 0x20, 0x29, 0x02, prod, 0x0E, 0x01, 0xF7]);
    midiOutput.send([0xF0, 0x00, 0x20, 0x29, 0x02, prod, 0x00, 0x7F, 0xF7]);
    // Send Clear all LEDs SysEx for MK3 (just in case)
    midiOutput.send([0xF0, 0x00, 0x20, 0x29, 0x02, prod, 0x02, 0x00, 0xF7]);
    console.info('[MIDI] Launchpad MK3 — Programmer Mode activé');
  } catch (err) {
    console.warn('[MIDI] Erreur activation Programmer Mode :', err);
  }
}

/**
 * Handle an incoming MIDI message — either capture or trigger.
 * @param {MIDIMessageEvent} event
 */
function onMidiMessage(event) {
  const [status, note, velocity] = event.data;
  const cmd = status & 0xF0;
  const channel = status & 0x0F;

  if (cmd !== 0x90 || velocity === 0) return; // Note On only

  if (capturingMidi) {
    const cartEl = capturingMidi;
    capturingMidi = null;
    cartEl.midiNote = { channel, note };
    updateShortcutBadge(cartEl);
    setLaunchpadLED(note, cartEl.style.background || '#ffffff');
    scheduleAutoSave();
    document.querySelector('.key-capture-overlay')?.remove();
    return;
  }

  document.querySelectorAll('.cart').forEach(cart => {
    const m = cart.midiNote;
    if (!m || m.note !== note || m.channel !== channel) return;
    if (isClient) {
      if (hostConn && hostConn.open) hostConn.send({ type: 'cartClick', idx: +cart.dataset.idx });
    } else if (cart.audio.src) {
      playPauseOrReset(cart);
    }
  });
}

// ── Launchpad LED Control ──────────────────────────────────────

/**
 * Return the SysEx product byte for the detected Launchpad model.
 * @returns {number|null}
 */
function getLaunchpadProductByte() {
  if (!midiOutput) return null;
  const n = midiOutput.name.toLowerCase();
  if (n.includes('mk2')) return 0x18; // MK2  (RGB 0-63)
  if (n.includes('pro mk3') || n.includes('pro 3')) return 0x0E; // Pro MK3
  if (n.includes('launchpad x')) return 0x0C; // Launchpad X
  return 0x0D; // Mini MK3 / unknown MK3
}

/**
 * Convert a CSS hex or rgb() colour string to { r, g, b } (0-255).
 * @param {string} colorStr
 * @returns {{ r: number, g: number, b: number }}
 */
function parseColor(colorStr) {
  if (!colorStr) return { r: 255, g: 255, b: 255 };

  // Try hex
  const mHex = /#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})/i.exec(colorStr);
  if (mHex) {
    return { r: parseInt(mHex[1], 16), g: parseInt(mHex[2], 16), b: parseInt(mHex[3], 16) };
  }

  // Try rgb / rgba
  const mRgb = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(colorStr);
  if (mRgb) {
    return { r: parseInt(mRgb[1], 10), g: parseInt(mRgb[2], 10), b: parseInt(mRgb[3], 10) };
  }

  return { r: 255, g: 255, b: 255 };
}

/**
 * Set a Launchpad pad LED to match a hex or rgb colour.
 * - Original / S / Mini 1st gen : Note On velocity (4-level R×G palette)
 * - MK2                         : SysEx RGB 0-63
 * - MK3 family                  : SysEx RGB 0-127 (requires Programmer Mode)
 * @param {number} note      MIDI note number of the pad
 * @param {string} colorStr  CSS color string (defaults to black/off)
 */
function setLaunchpadLED(note, colorStr) {
  if (!midiOutput) return;

  // Off state
  if (!colorStr || colorStr === '#000000') {
    clearLaunchpadLED(note);
    return;
  }

  const { r, g, b } = parseColor(colorStr);
  try {
    if (launchpadType === 'original') {
      // Launchpad Mini & Original - Velocity encoding: (green_0-3 << 4) | red_0-3 | flag
      // 0-3 brightness steps
      const r2 = Math.min(3, Math.round(r * 3 / 255));
      const g2 = Math.min(3, Math.round(g * 3 / 255));
      // Top 2 bits are clear/copy flags (0 = normal update), plus 12 to enable copy/clear flags
      const velocity = (g2 << 4) | r2 | 12;
      midiOutput.send([0x90, note, velocity]);
    } else if (launchpadType === 'mk2') {
      // Launchpad MK2 — RGB SysEx, values 0-63
      midiOutput.send([
        0xF0, 0x00, 0x20, 0x29, 0x02, 0x18, 0x0B,
        note,
        Math.round(r * 63 / 255),
        Math.round(g * 63 / 255),
        Math.round(b * 63 / 255),
        0xF7,
      ]);
    } else {
      // Launchpad MK3 family — RGB SysEx, values 0-127
      // Type byte 0x03 = RGB (0x00 would be palette index, not colour)
      const prod = getLaunchpadProductByte();
      midiOutput.send([
        0xF0, 0x00, 0x20, 0x29, 0x02, prod, 0x03, 0x03,
        note,
        Math.round(r * 127 / 255),
        Math.round(g * 127 / 255),
        Math.round(b * 127 / 255),
        0xF7,
      ]);
    }
  } catch (err) {
    console.warn('[MIDI] Erreur LED :', err);
  }
}

/** Turn off a Launchpad pad LED. */
function clearLaunchpadLED(note) {
  if (!midiOutput) return;
  if (launchpadType === 'original') {
    try { midiOutput.send([0x80, note, 0]); } catch (e) { /* ignore */ }
  } else {
    // For other launchpads we can send black
    const blackStr = '#000000';
    try {
      if (launchpadType === 'mk2') {
        midiOutput.send([0xF0, 0x00, 0x20, 0x29, 0x02, 0x18, 0x0B, note, 0, 0, 0, 0xF7]);
      } else {
        const prod = getLaunchpadProductByte();
        midiOutput.send([0xF0, 0x00, 0x20, 0x29, 0x02, prod, 0x03, 0x03, note, 0, 0, 0, 0xF7]);
      }
    } catch (e) { /* ignore */ }
  }
}

/** Force all 128 note LEDs off regardless of assignment. */
function clearAllLaunchpadLEDs() {
  if (!midiOutput) return;
  for (let note = 0; note <= 127; note++) {
    clearLaunchpadLED(note);
  }
}

/** Refresh all Launchpad LEDs to match current cart colours. */
function updateAllLaunchpadLEDs() {
  document.querySelectorAll('.cart').forEach(cart => {
    if (cart.midiNote) {
      setLaunchpadLED(cart.midiNote.note, cart.style.background || '#ffffff');
    }
  });
}

// ── MIDI Capture ───────────────────────────────────────────────

/**
 * Open a MIDI-capture overlay and assign the next MIDI note to a cart.
 * Initializes MIDI on first call if needed.
 * @param {HTMLElement} cartEl
 */
async function startMidiCapture(cartEl) {
  if (!midiAccess) {
    await initMidi();
    if (!midiAccess) {
      alert('Accès MIDI non disponible.\nAutorisez l\'accès MIDI dans la barre d\'adresse.');
      return;
    }
  }
  // Re-assert Programmer Mode each time — device may have reset to User/Session layout
  if (launchpadType === 'mk3') {
    enterProgrammerMode();
    await new Promise(r => setTimeout(r, 80));
  }
  createCaptureOverlay(
    '🎹 Appuyez sur un pad ou bouton MIDI…',
    () => { capturingMidi = null; },
    () => {
      capturingMidi = null;
      if (cartEl.midiNote) {
        clearLaunchpadLED(cartEl.midiNote.note);
        delete cartEl.midiNote;
        updateShortcutBadge(cartEl);
      }
    }
  );
  capturingMidi = cartEl;
}

/* =============================================================
   10. CUE POINTS / WAVEFORM EDITOR
   ============================================================= */

/**
 * Generate normalised waveform samples from a File/Blob.
 * Returns Float32Array of `samples` values (0-1), or null on error.
 */
async function generateWaveform(file, samples = 700) {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
    const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);
    tempCtx.close();
    const rawData = audioBuffer.getChannelData(0);
    const blockSize = Math.floor(rawData.length / samples);
    const data = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      let sum = 0;
      for (let j = 0; j < blockSize; j++) sum += Math.abs(rawData[blockSize * i + j]);
      data[i] = sum / blockSize;
    }
    const max = Math.max(...data);
    const waveform = max > 0 ? data.map(v => v / max) : data;
    return { waveform, audioBuffer };
  } catch (e) {
    console.warn('[CUE] Waveform generation failed', e);
    return { waveform: null, audioBuffer: null };
  }
}

/**
 * Draw waveform + playhead + CUT-IN/CUT-OUT markers on a canvas.
 */
function drawCueWaveform(canvas, waveform, progressPct, cueInPct, cueOutPct) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const inX  = (cueInPct  ?? 0) * w;
  const outX = (cueOutPct ?? 1) * w;

  if (!waveform || !waveform.length) {
    ctx.fillStyle = '#444';
    ctx.fillRect(0, h / 2 - 1, w, 2);
  } else {
    const barW  = w / waveform.length;
    const center = h / 2;

    // Outside cut range — muted
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    for (let i = 0; i < waveform.length; i++) {
      const x = i * barW;
      if (x < inX || x > outX) {
        const bh = Math.max(2, waveform[i] * h * 0.78);
        ctx.fillRect(x, center - bh / 2, Math.max(1, barW - 1), bh);
      }
    }

    // Inside cut range — unplayed
    ctx.fillStyle = 'rgba(255,255,255,0.26)';
    for (let i = 0; i < waveform.length; i++) {
      const x = i * barW;
      if (x >= inX && x <= outX) {
        const bh = Math.max(2, waveform[i] * h * 0.78);
        ctx.fillRect(x, center - bh / 2, Math.max(1, barW - 1), bh);
      }
    }

    // Played portion (clip to progress)
    if (progressPct > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, progressPct * w, h);
      ctx.clip();
      ctx.fillStyle = '#6366f1';
      for (let i = 0; i < waveform.length; i++) {
        const bh = Math.max(2, waveform[i] * h * 0.78);
        ctx.fillRect(i * barW, center - bh / 2, Math.max(1, barW - 1), bh);
      }
      ctx.restore();
    }
  }

  // Playhead
  if (progressPct > 0 && progressPct < 1) {
    const px = progressPct * w;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
    ctx.restore();
  }

  // CUT-IN marker (green, triangle pointing right)
  if (cueInPct !== null) {
    const mx = Math.round(cueInPct * w);
    ctx.save();
    ctx.strokeStyle = '#22c55e';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, h); ctx.stroke();
    const t = 8;
    ctx.fillStyle = '#22c55e';
    ctx.beginPath();
    ctx.moveTo(mx, 3);
    ctx.lineTo(mx + t, 3 + t * 0.6);
    ctx.lineTo(mx, 3 + t * 1.2);
    ctx.closePath();
    ctx.fill();
    ctx.font = 'bold 9px Inter,system-ui,sans-serif';
    ctx.fillStyle = '#22c55e';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'left';
    ctx.fillText('IN', mx + 3, h - 2);
    ctx.restore();
  }

  // CUT-OUT marker (red, triangle pointing left)
  if (cueOutPct !== null) {
    const mx = Math.round(cueOutPct * w);
    ctx.save();
    ctx.strokeStyle = '#ef4444';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, h); ctx.stroke();
    const t = 8;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.moveTo(mx, 3);
    ctx.lineTo(mx - t, 3 + t * 0.6);
    ctx.lineTo(mx, 3 + t * 1.2);
    ctx.closePath();
    ctx.fill();
    ctx.font = 'bold 9px Inter,system-ui,sans-serif';
    ctx.fillStyle = '#ef4444';
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right';
    ctx.fillText('OUT', mx - 3, h - 2);
    ctx.restore();
  }
}

/**
 * Open the Cue editor modal for a cart element.
 */
function openCueModal(cartEl) {
  const dur = cartEl.audio.duration || 0;
  document.querySelector('.cue-overlay')?.remove();

  let cueIn  = cartEl.cueIn  ?? null;
  let cueOut = cartEl.cueOut ?? null;
  let isDraggingIn  = false;
  let isDraggingOut = false;
  let cueMode = 'in'; // 'in' | 'out'
  let animFrame;
  const HIT_PX = 14;

  const overlay = document.createElement('div');
  overlay.className = 'cue-overlay';
  overlay.innerHTML = `
    <div class="cue-modal">
      <div class="cue-modal-header">
        <span class="cue-modal-title">🎯 Cue &mdash; <span class="cue-cart-name">${cartEl.querySelector('.label').textContent}</span></span>
        <button class="cue-close-btn" title="Fermer">✕</button>
      </div>
      <div class="cue-info-row">
        <div class="cue-point-info cue-in-info">
          <span class="cue-point-label cue-in-lbl">▶ CUT-IN</span>
          <span class="cue-point-time cue-in-time">--:--</span>
        </div>
        <div class="cue-total-dur">Durée : <strong>${dur ? formatTime(dur) : '--:--'}</strong></div>
        <div class="cue-point-info cue-out-info">
          <span class="cue-point-label cue-out-lbl">■ CUT-OUT</span>
          <span class="cue-point-time cue-out-time">--:--</span>
        </div>
      </div>
      <div class="cue-canvas-wrap">
        <canvas class="cue-canvas"></canvas>
        <div class="cue-canvas-loading">⏳ Analyse de la forme d'onde…</div>
      </div>
      <div class="cue-controls-row">
        <div class="cue-mode-group">
          <span class="cue-mode-lbl">Placer :</span>
          <button class="cue-mode-btn cue-mode-in-btn active">▶ CUT-IN</button>
          <button class="cue-mode-btn cue-mode-out-btn">■ CUT-OUT</button>
        </div>
        <span class="cue-hint">Clic pour placer · Glisser pour déplacer · Clic droit pour supprimer</span>
      </div>
      <div class="cue-footer">
        <button class="cue-btn cue-btn-clear">Effacer les cues</button>
        <button class="cue-btn cue-btn-apply">✓ Appliquer</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const canvas     = overlay.querySelector('.cue-canvas');
  const loadingEl  = overlay.querySelector('.cue-canvas-loading');
  const inTimeEl   = overlay.querySelector('.cue-in-time');
  const outTimeEl  = overlay.querySelector('.cue-out-time');
  const modeInBtn  = overlay.querySelector('.cue-mode-in-btn');
  const modeOutBtn = overlay.querySelector('.cue-mode-out-btn');

  function updateTimes() {
    inTimeEl.textContent  = (cueIn  !== null && dur) ? formatTime(cueIn  * dur) : '--:--';
    outTimeEl.textContent = (cueOut !== null && dur) ? formatTime(cueOut * dur) : '--:--';
    inTimeEl.style.color  = cueIn  !== null ? '#22c55e' : '';
    outTimeEl.style.color = cueOut !== null ? '#ef4444' : '';
  }

  function fitCanvas() {
    const w = canvas.offsetWidth, h = canvas.offsetHeight;
    if (w > 0 && canvas.width  !== w) canvas.width  = w;
    if (h > 0 && canvas.height !== h) canvas.height = h;
  }

  function redraw() {
    fitCanvas();
    drawCueWaveform(canvas, cartEl.waveformData,
      dur ? (cartEl.audio.currentTime / dur) : 0,
      cueIn, cueOut);
  }

  function getHit(evt) {
    const r = canvas.getBoundingClientRect();
    const x = evt.clientX - r.left;
    const W = r.width;
    const di   = cueIn  !== null ? Math.abs(x - cueIn  * W) : Infinity;
    const dout = cueOut !== null ? Math.abs(x - cueOut * W) : Infinity;
    if (di   <= HIT_PX && di   <= dout) return 'in';
    if (dout <= HIT_PX)                 return 'out';
    return null;
  }

  function setMode(m) {
    cueMode = m;
    modeInBtn.classList.toggle('active',  m === 'in');
    modeOutBtn.classList.toggle('active', m === 'out');
  }
  modeInBtn.onclick  = () => setMode('in');
  modeOutBtn.onclick = () => setMode('out');

  canvas.addEventListener('mousemove', evt => {
    if (isDraggingIn || isDraggingOut) return;
    canvas.style.cursor = getHit(evt) ? 'ew-resize' : 'crosshair';
  });

  canvas.addEventListener('contextmenu', evt => {
    evt.preventDefault();
    const hit = getHit(evt);
    if (hit === 'in')  { cueIn  = null; updateTimes(); redraw(); }
    if (hit === 'out') { cueOut = null; updateTimes(); redraw(); }
  });

  // Pointer-based placement + drag (works reliably at canvas edges on mobile)
  let _ptrDownX = null;

  canvas.addEventListener('pointerdown', evt => {
    canvas.setPointerCapture(evt.pointerId); // always capture → pointerup fires even at edges
    evt.preventDefault();                    // prevent synthesized click & browser gestures
    _ptrDownX = evt.clientX;
    const hit = getHit(evt);
    if (hit) {
      isDraggingIn  = hit === 'in';
      isDraggingOut = hit === 'out';
      canvas.style.cursor = 'ew-resize';
    }
  });

  canvas.addEventListener('pointermove', evt => {
    if (!isDraggingIn && !isDraggingOut) return;
    const r   = canvas.getBoundingClientRect();
    let pct   = Math.max(0, Math.min(1, (evt.clientX - r.left) / r.width));
    if (isDraggingIn) {
      if (cueOut !== null) pct = Math.min(pct, cueOut - 0.001);
      cueIn = pct;
    } else {
      if (cueIn !== null) pct = Math.max(pct, cueIn + 0.001);
      cueOut = pct;
    }
    updateTimes(); redraw();
    evt.preventDefault();
  });

  canvas.addEventListener('pointerup', evt => {
    const wasDragging = isDraggingIn || isDraggingOut;
    isDraggingIn = false; isDraggingOut = false;
    canvas.style.cursor = 'crosshair';
    // Tap (not drag) → place the cue at the tapped position
    if (!wasDragging && _ptrDownX !== null && Math.abs(evt.clientX - _ptrDownX) < 8) {
      const r = canvas.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (evt.clientX - r.left) / r.width));
      if (cueMode === 'in') {
        cueIn = pct;
        if (cueOut !== null && cueOut <= cueIn + 0.001) cueOut = null;
      } else {
        cueOut = pct;
        if (cueIn !== null && cueIn >= cueOut - 0.001) cueIn = null;
      }
      updateTimes(); redraw();
    }
    _ptrDownX = null;
  });

  canvas.addEventListener('pointercancel', () => {
    isDraggingIn = false; isDraggingOut = false;
    _ptrDownX = null;
  });

  const resizeObs = new ResizeObserver(() => redraw());

  function closeModal() {
    cancelAnimationFrame(animFrame);
    resizeObs.disconnect();
    overlay.remove();
  }

  overlay.querySelector('.cue-close-btn').onclick = closeModal;
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  overlay.querySelector('.cue-btn-clear').onclick = () => {
    cueIn = null; cueOut = null;
    updateTimes(); redraw();
  };

  overlay.querySelector('.cue-btn-apply').onclick = () => {
    cartEl.cueIn  = cueIn;
    cartEl.cueOut = cueOut;
    scheduleAutoSave();
    if (dur) {
      const inP  = cueIn  ?? 0;
      const outP = cueOut ?? 1;
      const displayDur = (cueIn !== null || cueOut !== null) ? (outP - inP) * dur : dur;
      cartEl.querySelector('.time').textContent = formatTime(Math.max(0, displayDur));
    }
    updateCueBadge(cartEl);
    closeModal();
  };

  // Load or generate waveform
  if (cartEl.waveformData) {
    loadingEl.style.display = 'none';
  } else if (cartEl.file) {
    generateWaveform(cartEl.file).then(({ waveform, audioBuffer }) => {
      if (cartEl.file) {
        cartEl.waveformData = waveform; // guard against cart cleared
        if (!cartEl.audioBuffer) cartEl.audioBuffer = audioBuffer;
      }
      if (overlay.isConnected) { loadingEl.style.display = 'none'; redraw(); }
    });
  } else {
    loadingEl.style.display = 'none';
  }

  updateTimes();

  // Animate playhead + start ResizeObserver
  function animate() { redraw(); animFrame = requestAnimationFrame(animate); }
  requestAnimationFrame(() => {
    fitCanvas();
    resizeObs.observe(canvas);
    animate();
  });
}

/**
 * Show/hide the CUE badge on a cart (indicates active cue points).
 */
function updateCueBadge(cartEl) {
  let badge = cartEl.querySelector('.cue-badge');
  const hasCue = cartEl.cueIn !== null || cartEl.cueOut !== null;
  if (hasCue) {
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'cue-badge';
      cartEl.appendChild(badge);
    }
    badge.textContent = 'CUE';
  } else if (badge) {
    badge.remove();
  }
}

/* =============================================================
   8. AUDIO OUTPUT DEVICE SELECTION
   ============================================================= */

/** DeviceId de la sortie audio master (persisté en localStorage) */
let selectedOutputDeviceId = localStorage.getItem('audioOutputDeviceId') || 'default';
/** Label mémorisé du device sélectionné */
let selectedOutputLabel = localStorage.getItem('audioOutputLabel') || '';

/**
 * Énumère les périphériques de sortie audio (sans demande de permission).
 * @returns {Promise<MediaDeviceInfo[]>}
 */
async function enumerateOutputs() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter(d => d.kind === 'audiooutput');
}

/**
 * Applique un périphérique de sortie à tous les éléments audio des carts.
 * @param {string} deviceId
 * @param {string} [label]
 */
async function applyOutputDevice(deviceId, label) {
  if (!('setSinkId' in HTMLAudioElement.prototype)) return;
  selectedOutputDeviceId = deviceId;
  selectedOutputLabel = label || '';
  localStorage.setItem('audioOutputDeviceId', deviceId);
  localStorage.setItem('audioOutputLabel', selectedOutputLabel);
  const promises = [];
  document.querySelectorAll('.cart').forEach(cart => {
    if (cart.audio) promises.push(cart.audio.setSinkId(deviceId).catch(() => {}));
  });
  // Routage du contexte Web Audio (gapless loop) — Chrome 110+
  if (_sharedAudioCtx && typeof _sharedAudioCtx.setSinkId === 'function') {
    promises.push(_sharedAudioCtx.setSinkId(deviceId).catch(() => {}));
  }
  await Promise.all(promises);
  // Met à jour le libellé du bouton
  const btn = document.getElementById('audioOutputBtn');
  if (btn) {
    const short = selectedOutputLabel
      ? selectedOutputLabel.replace(/\s*\(.*\)\s*$/, '').trim() // supprime la partie entre parenthèses
      : '';
    btn.title = selectedOutputLabel || 'Choisir la carte son de sortie du master';
    btn.innerHTML = short ? `🔊 ${short}` : '🔊 Carte son de sortie';
  }
}

/**
 * Remplit (ou recharge) le contenu du panel avec la liste des périphériques de SORTIE.
 * N'utilise jamais getUserMedia (entrée micro) — uniquement les API de sortie audio.
 * @param {HTMLElement} panel
 * @param {HTMLElement} anchorBtn
 */
async function populateAudioOutputPanel(panel, anchorBtn) {
  panel.innerHTML = '<div class="aop-msg">Détection des cartes son…</div>';

  const outputs = await enumerateOutputs();
  panel.innerHTML = '';

  // Classify outputs
  const defaultDev = outputs.find(d => d.deviceId === 'default');
  const commDev = outputs.find(d => d.deviceId === 'communications');
  const others = outputs.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications');
  const hasUnlabelled = others.some(d => !d.label);

  // Build ordered list — show ALL devices; use generic fallback name if label is empty
  const list = [
    { deviceId: 'default', label: defaultDev?.label || 'Sortie par défaut du système' },
  ];
  let unnamed = 0;
  others.forEach(d => {
    unnamed++;
    list.push({ deviceId: d.deviceId, label: d.label || `Sortie audio ${unnamed}` });
  });
  if (commDev) list.push({ deviceId: 'communications', label: commDev.label || 'Sortie de communication' });

  list.forEach(dev => {
    const active = dev.deviceId === selectedOutputDeviceId;
    const item = document.createElement('div');
    item.className = 'aop-item' + (active ? ' aop-active' : '');
    item.title = dev.label;
    item.innerHTML = `<span class="aop-check">${active ? '✓' : ''}</span><span class="aop-label">${dev.label}</span>`;
    item.addEventListener('click', async () => {
      await applyOutputDevice(dev.deviceId, dev.label);
      panel.remove();
    });
    panel.appendChild(item);
  });

  const sep = document.createElement('div');
  sep.className = 'aop-sep';
  panel.appendChild(sep);

  if (navigator.mediaDevices && typeof navigator.mediaDevices.selectAudioOutput === 'function') {
    // Firefox / navigateur avec selectAudioOutput natif
    const btnBrowse = document.createElement('div');
    btnBrowse.className = 'aop-item aop-unlock';
    btnBrowse.innerHTML = '<span class="aop-check">🔊</span><span class="aop-label">Parcourir les cartes son de sortie…</span>';
    btnBrowse.title = 'Ouvre le sélecteur natif du navigateur';
    btnBrowse.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        const device = await navigator.mediaDevices.selectAudioOutput();
        await applyOutputDevice(device.deviceId, device.label);
        panel.remove();
        openAudioOutputPanel(anchorBtn);
      } catch (_) { /* annulé */ }
    });
    panel.appendChild(btnBrowse);
  } else if (hasUnlabelled && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    // Chrome : technique getUserMedia pour révéler les noms (même méthode que Jitsi Meet)
    // Le stream est coupé immédiatement — le micro n'est pas utilisé pour la lecture
    const btnUnlock = document.createElement('div');
    btnUnlock.className = 'aop-item aop-unlock';
    btnUnlock.innerHTML = '<span class="aop-check">🔓</span><span class="aop-label">Autoriser pour voir les autres carte son</span>';
    btnUnlock.title = 'Requiert une autorisation momentanée — le micro ne sera pas utilisé';
    btnUnlock.addEventListener('click', async e => {
      e.stopPropagation();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        stream.getTracks().forEach(t => t.stop()); // libère le micro immédiatement
        panel.remove();
        openAudioOutputPanel(anchorBtn); // ré-ouvre avec les vrais noms
      } catch (_) {
        const errNote = document.createElement('div');
        errNote.className = 'aop-msg';
        errNote.textContent = '⚠ Permission refusée — impossible d\'afficher les vrais noms.';
        btnUnlock.replaceWith(errNote);
      }
    });
    panel.appendChild(btnUnlock);
  }
}

/**
 * Ouvre (ou ferme) le panel de sélection de carte son sous le bouton donné.
 * @param {HTMLElement} anchorBtn
 */
async function openAudioOutputPanel(anchorBtn) {
  const existing = document.getElementById('audioOutputPanel');
  if (existing) { existing.remove(); return; }

  const panel = document.createElement('div');
  panel.id = 'audioOutputPanel';
  panel.className = 'audio-output-panel';
  document.body.appendChild(panel);

  // Positionnement sous le bouton
  const rect = anchorBtn.getBoundingClientRect();
  panel.style.top = (rect.bottom + 6) + 'px';
  panel.style.right = (window.innerWidth - rect.right) + 'px';

  await populateAudioOutputPanel(panel, anchorBtn);

  // Fermeture au clic extérieur
  setTimeout(() => {
    document.addEventListener('click', function outsideClick(e) {
      if (!panel.isConnected) { document.removeEventListener('click', outsideClick); return; }
      if (!panel.contains(e.target) && e.target !== anchorBtn) {
        panel.remove();
        document.removeEventListener('click', outsideClick);
      }
    });
  }, 0);
}

/* =============================================================
   9. BOOTSTRAP / MAIN
   ============================================================= */

document.addEventListener('DOMContentLoaded', () => {

  /* ── Build cart grid ──────────────────────────────────── */
  const grid = document.getElementById('grid');

  for (let i = 0; i < NB_CARTS; i++) {
    const cart = document.createElement('div');
    cart.className = 'cart empty';
    cart.dataset.idx = i;
    cart.innerHTML = `
      <div class="label">Cartouche ${i + 1}</div>
      <div class="time"></div>
      <div class="progress"></div>
    `;

    // Per-cart user volume (0-1)
    cart.userVolume = 1;

    // Audio element
    cart.audio = new Audio();
    cart.audio.preload = 'auto';

    // Durée : 'loadedmetadata' peut arriver bien après assignFile(). Ces
    // écouteurs, posés une fois pour toutes, rafraîchissent l'affichage dès que
    // la durée devient connue.
    ['loadedmetadata', 'durationchange'].forEach(ev =>
      cart.audio.addEventListener(ev, () => {
        if (cart.audio.paused && !cart._glActive) refreshCartTime(cart);
        broadcastCartMeta(cart);
      })
    );

    // Precise CUT-OUT enforcement via timeupdate (fires even in background)
    cart.audio.addEventListener('timeupdate', () => {
      if (cart.audio.paused || cart.cueOut === null) return;
      const dur = cart.audio.duration;
      if (!dur) return;
      if (cart.audio.currentTime >= cart.cueOut * dur) {
        cart.audio.pause();
        cart.audio.currentTime = (cart.cueIn !== null) ? cart.cueIn * dur : 0;
        cart.classList.remove('playing', 'blinking');
        restoreCartLED(cart);
        resetProgress(cart);
        broadcastState(i, false, 0, cart.querySelector('.time').textContent, cart.style.background || '');
      }
    });

    cart.audio.addEventListener('ended', () => {
      cart.classList.remove('playing', 'blinking');
      restoreCartLED(cart);
      resetProgress(cart);
      broadcastState(i, false, 0, cart.querySelector('.time').textContent, cart.style.background || '');
    });

    /* Click */
    cart.addEventListener('click', () => {
      if (isClient) {
        // Clients send a signal to the host
        if (hostConn && hostConn.open) {
          hostConn.send({ type: 'cartClick', idx: i });
        }
        return;
      }
      if (cart.audio.src) {
        playPauseOrReset(cart);
      } else {
        pickFile(f => assignFile(cart, f));
      }
    });

    /* Drag & drop */
    cart.addEventListener('dragover', e => e.preventDefault());
    cart.addEventListener('drop', e => {
      e.preventDefault();
      if (isClient) return;
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith('audio/')) assignFile(cart, f);
    });

    /* Right-click context menu */
    cart.addEventListener('contextmenu', e => {
      if (isClient) return;
      e.preventDefault();
      showCtxMenu(e.clientX, e.clientY, cart);
    });

    /* Long press (mobile) */
    let longPressTimer;
    cart.addEventListener('touchstart', () => {
      longPressTimer = setTimeout(() => showCtxMenuMobile(cart), 600);
    }, { passive: true });
    ['touchend', 'touchmove', 'touchcancel'].forEach(ev =>
      cart.addEventListener(ev, () => clearTimeout(longPressTimer), { passive: true })
    );

    grid.appendChild(cart);
  }

  /* ── Wire header buttons ──────────────────────────────── */
  document.getElementById('stopAll').onclick = stopAll;
  document.getElementById('clearAll').onclick = clearAllFiles;
  document.getElementById('savePalette').onclick = saveConfig;
  document.getElementById('loadPalette').onclick = () =>
    document.getElementById('paletteLoader').click();
  document.getElementById('paletteLoader').onchange = loadConfig;

  /* ── Hamburger menu ───────────────────────────────────── */
  const menuToggle = document.getElementById('menuToggle');
  const controls = document.getElementById('controls');
  menuToggle.onclick = () => controls.classList.toggle('open');
  document.addEventListener('click', e => {
    if (!controls.contains(e.target) && e.target !== menuToggle) {
      controls.classList.remove('open');
    }
  });

  /* ── More menu dropdown (desktop) ────────────────────── */
  const moreMenuBtn = document.getElementById('moreMenuBtn');
  const moreDropdown = document.getElementById('moreDropdown');
  if (moreMenuBtn && moreDropdown) {
    moreMenuBtn.onclick = e => {
      e.stopPropagation();
      moreDropdown.classList.toggle('open');
    };
    document.addEventListener('click', e => {
      if (!moreDropdown.contains(e.target) && e.target !== moreMenuBtn) {
        moreDropdown.classList.remove('open');
      }
    });
  }

  /* ── Audio output device selection ───────────────────── */
  const audioOutputBtn = document.getElementById('audioOutputBtn');
  if (audioOutputBtn) {
    // Restaure le libellé mémorisé
    if (selectedOutputLabel) {
      const short = selectedOutputLabel.replace(/\s*\(.*\)\s*$/, '').trim();
      audioOutputBtn.innerHTML = short ? `🔊 ${short}` : '🔊 Carte son de sortie';
      audioOutputBtn.title = selectedOutputLabel;
    }
    audioOutputBtn.addEventListener('click', e => {
      e.stopPropagation();
      openAudioOutputPanel(audioOutputBtn);
    });
  }

  /* ── 2nd-click mode: reset all paused-mid-play carts ─── */
  document.getElementById('secondModeCheckbox').addEventListener('change', function () {
    if (this.checked) {
      document.querySelectorAll('.cart').forEach(c => {
        const a = c.audio;
        if (a.src && a.paused && a.currentTime > 0) {
          a.currentTime = 0;
          c.classList.remove('playing', 'blinking');
          resetProgress(c);
        }
      });
    }
    // Slave: propagate setting to host
    if (isClient && hostConn && hostConn.open) {
      hostConn.send({ type: 'setting', key: 'secondModeCheckbox', value: this.checked });
    }
  });

  /* ── Mix mode: propagate to host if slave ─────────────── */
  document.getElementById('mixMode').addEventListener('change', function () {
    if (isClient && hostConn && hostConn.open) {
      hostConn.send({ type: 'setting', key: 'mixMode', value: this.checked });
    }
  });

  /* ── Collaboration modal ──────────────────────────────── */
  const overlay = document.getElementById('collabOverlay');
  const collabBtn = document.getElementById('collabBtn');
  const collabClose = document.getElementById('collabClose');
  const startHostBtn = document.getElementById('startHostBtn');
  const hostInfo = document.getElementById('hostInfo');
  const roomIdDisp = document.getElementById('roomIdDisplay');
  const roomLinkEl = document.getElementById('roomLink');
  const copyLinkBtn = document.getElementById('copyLinkBtn');

  collabBtn.onclick = () => overlay.classList.remove('hidden');
  collabClose.onclick = () => overlay.classList.add('hidden');
  overlay.addEventListener('click', e => {
    if (e.target === overlay) overlay.classList.add('hidden');
  });

  startHostBtn.onclick = () => {
    if (isHost) return; // already started
    const roomId = randomRoomId();
    startHost(roomId);

    const link = `${location.origin}${location.pathname}?room=${roomId}`;
    roomIdDisp.textContent = roomId;
    roomLinkEl.value = link;
    hostInfo.classList.remove('hidden');
    startHostBtn.disabled = true;
    startHostBtn.textContent = '✅ Session active';
  };

  copyLinkBtn.onclick = () => {
    navigator.clipboard.writeText(roomLinkEl.value).then(() => {
      copyLinkBtn.textContent = '✔ Copié !';
      setTimeout(() => (copyLinkBtn.textContent = '📋 Copier'), 2000);
    });
  };

  /* ── Initial layout & collab auto-join ───────────────── */
  resizeCarts();
  autoLoad(); // Restore last palette from IndexedDB
  initCollaboration();
});
