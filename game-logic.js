/**
 * game-logic.js
 * ════════════════════════════════════════════════════════════════
 * Boerenbridge — Core Game Engine & UI Controller
 *
 * VERANTWOORDELIJKHEDEN:
 *   - State-machine die het spel door alle fasen leidt
 *   - Spelregel validatie (dealer-beperking, ronde-validatie)
 *   - Score berekening (per ronde + cumulatief)
 *   - Herberekening bij correcties (correctie-propagatie)
 *   - DOM rendering voor alle views
 *   - Communicatie met database-service.js
 *
 * RONDE STRUCTUUR (15 rondes):
 *   Kaarten: [1,2,3,4,5,6,7,7,7,6,5,4,3,2,1]
 *
 * PUNTEN FORMULE:
 *   Gehaald: 5 + (2 × slagen)
 *   Gemist:  -(2 × |bod − slagen|)
 *
 * STATE MACHINE:
 *   lobby → bidding → results → scoreboard → (next round) → bidding
 *                                          → (last round)  → stats
 * ════════════════════════════════════════════════════════════════
 */

import {
  getAllPlayers,
  addPlayer,
  createGame,
  saveGameRounds,
  finalizeGame,
  calculateGlobalRecords,
  getGamesForPlayer
} from './database-service.js';

/* ════════════════════════════════════════════════════════════════
   CONSTANTEN
   ════════════════════════════════════════════════════════════════ */

/**
 * Het aantal kaarten per ronde (index 0 = ronde 1, ..., index 14 = ronde 15).
 * De reeks loopt op van 1 t/m 7, staat op 7 voor 3 rondes, dan daalt terug.
 */
const CARDS_PER_ROUND = [1, 2, 3, 4, 5, 6, 7, 7, 7, 6, 5, 4, 3, 2, 1];
const TOTAL_ROUNDS    = 15; // CARDS_PER_ROUND.length

/* ════════════════════════════════════════════════════════════════
   APPLICATIE STATE
   Eén centraal state-object — "single source of truth"
   ════════════════════════════════════════════════════════════════ */
let state = {
  // Fase tracking
  phase: 'lobby',   // 'lobby' | 'bidding' | 'results' | 'scoreboard' | 'stats'

  // Spelers (lobby)
  allPlayers:       [],   // Alle spelers uit Firestore
  selectedPlayers:  [],   // [{id, name}] — in speel-volgorde

  // Spel data
  gameId:           null, // Firestore document ID van huidig spel
  currentRound:     0,    // 0-gebaseerde index (0 = ronde 1)
  startPlayerIndex: 0,    // Index van de beginspeler in ronde 1 (willekeurig)

  /**
   * rounds: Array van ronde-objecten, elk met:
   * {
   *   roundIndex: number,
   *   cards:      number,         // Aantal kaarten in deze ronde
   *   dealerIndex: number,        // Index van de dealer (laatste bieder)
   *   firstBidderIndex: number,   // Index van de eerste bieder
   *   playerData: {               // Per speler (geïndexeerd op naam)
   *     [playerName]: {
   *       bid:    number | null,
   *       tricks: number | null,
   *       score:  number | null
   *     }
   *   }
   * }
   */
  rounds: [],

  // Edit modus (scorebord)
  isEditMode: false,

  // Pending edit
  editContext: null  // { roundIndex, playerName, field: 'bid'|'tricks' }
};

/* ════════════════════════════════════════════════════════════════
   SCORE BEREKENING
   ════════════════════════════════════════════════════════════════ */

/**
 * Bereken de score voor één speler in één ronde.
 *
 * Formule:
 *   Gehaald (bid === tricks): 5 + (2 × tricks)
 *   Gemist  (bid !== tricks): -(2 × |bid - tricks|)
 *
 * @param {number} bid    - Geboden slagen
 * @param {number} tricks - Gehaalde slagen
 * @returns {number} De berekende score
 */
function calculateRoundScore(bid, tricks) {
  if (bid === tricks) {
    return 5 + (2 * tricks);
  } else {
    return -(2 * Math.abs(bid - tricks));
  }
}

/**
 * Bereken de cumulatieve totaalscores voor alle spelers
 * op basis van alle gespeelde rondes.
 *
 * @param {string[]} playerNames - Namen van alle spelers
 * @param {Array}    rounds      - Array van ronde-objecten (state.rounds)
 * @returns {Object} { [playerName]: cumulativeScore }
 */
function calculateCumulativeScores(playerNames, rounds) {
  const totals = {};
  playerNames.forEach(name => totals[name] = 0);

  for (const round of rounds) {
    if (!round.playerData) continue;
    for (const name of playerNames) {
      const data = round.playerData[name];
      if (data && data.score !== null) {
        totals[name] += data.score;
      }
    }
  }
  return totals;
}

/**
 * Herbereken alle ronde-scores en cumulatieve totalen
 * vanaf een bepaalde ronde-index.
 *
 * Dit wordt gebruikt na een correctie: we herberekenen de score
 * voor de gecorrigeerde ronde én alle volgende rondes hoeven
 * geen herberekening (hun bid/tricks zijn onveranderd), maar
 * de cumulatieve scores moeten wel opnieuw berekend worden.
 *
 * Stappen:
 * 1. Voor elke ronde >= startRoundIndex: herbereken de 'score' velden
 *    op basis van de (mogelijk gecorrigeerde) bid en tricks waarden.
 * 2. (Cumulatieve scores worden on-the-fly berekend bij rendering.)
 *
 * @param {number} startRoundIndex - Eerste ronde die herberekend moet worden
 */
function recalculateFromRound(startRoundIndex) {
  const playerNames = state.selectedPlayers.map(p => p.name);

  for (let i = startRoundIndex; i < state.rounds.length; i++) {
    const round = state.rounds[i];
    if (!round || !round.playerData) continue;

    for (const name of playerNames) {
      const data = round.playerData[name];
      if (data && data.bid !== null && data.tricks !== null) {
        // Herbereken score op basis van huidige (eventueel gecorrigeerde) waarden
        data.score = calculateRoundScore(data.bid, data.tricks);
      }
    }
  }
  // Geen return nodig: state.rounds is mutated in place
}

/* ════════════════════════════════════════════════════════════════
   DEALER BEPERKING LOGICA
   ════════════════════════════════════════════════════════════════ */

/**
 * Bepaal het "verboden bod" voor de dealer (laatste bieder) in een ronde.
 *
 * REGEL: De dealer mag NOOIT een bod plaatsen waardoor de som van
 * alle biedingen exact gelijk is aan het aantal kaarten in die ronde.
 * Dit zorgt ervoor dat het spel nooit "uitkomt" (niemand hoeft te winnen).
 *
 * @param {number}   cards          - Kaarten in huidige ronde
 * @param {number[]} existingBids   - Alle biedingen behalve die van de dealer
 * @returns {number | null}         - Het verboden bod, of null als geen beperking
 *
 * VOORBEELD:
 *   Ronde met 5 kaarten, 3 spelers hebben geboden: [2, 1]
 *   Som van bestaande biedingen = 3
 *   Verboden bod = 5 - 3 = 2  (want 3 + 2 = 5 = aantal kaarten)
 *   Als verboden bod < 0: geen beperking (som is al > aantal kaarten)
 *   Als verboden bod > cards: geen beperking (niet mogelijk te bieden)
 */
function calculateForbiddenBid(cards, existingBids) {
  const sumExisting = existingBids.reduce((a, b) => a + b, 0);
  const forbidden   = cards - sumExisting;

  // Verboden bod moet binnen het geldige bied-bereik liggen [0, cards]
  if (forbidden >= 0 && forbidden <= cards) {
    return forbidden;
  }
  return null; // Geen beperking van toepassing
}

/**
 * Bepaal de volgorde van bieders voor een ronde.
 *
 * REGEL: De beginspeler schuift elke ronde één positie naar rechts.
 * De dealer (gever) is de speler VÓÓR de eerste bieder (= laatste bieder).
 *
 * @param {number} roundIndex - 0-gebaseerde ronde-index
 * @returns {{ firstBidderIndex: number, dealerIndex: number }}
 */
function getBiddingOrder(roundIndex) {
  const n = state.selectedPlayers.length;
  // De eerste bieder schuift elke ronde één positie naar rechts
  const firstBidderIndex = (state.startPlayerIndex + roundIndex) % n;
  // De dealer is de speler die als laatste biedt = één vóór de eerste bieder
  const dealerIndex      = (firstBidderIndex + n - 1) % n;
  return { firstBidderIndex, dealerIndex };
}

/* ════════════════════════════════════════════════════════════════
   EIND-KLASSEMENT BEREKENING
   ════════════════════════════════════════════════════════════════ */

/**
 * Bereken de eindrangorde voor een afgesloten spel.
 * Bij gelijke score delen spelers de plek, de volgende plek
 * wordt overgeslagen (bijv. 1, 1, 3, 4).
 *
 * @param {Object} totals - { [playerName]: totalScore }
 * @returns {Array<{playerName, totalScore, rank}>}
 */
function calculateFinalRanking(totals) {
  // Sorteer aflopend op score
  const sorted = Object.entries(totals)
    .map(([name, score]) => ({ playerName: name, totalScore: score }))
    .sort((a, b) => b.totalScore - a.totalScore);

  // Wijs rangen toe (met gedeelde plekken)
  let rank = 1;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].totalScore < sorted[i - 1].totalScore) {
      // Nieuw lagere score → rang = positie + 1
      rank = i + 1;
    }
    sorted[i].rank = rank;
  }
  return sorted;
}

/* ════════════════════════════════════════════════════════════════
   DOM HULPFUNCTIES
   ════════════════════════════════════════════════════════════════ */

/** Verberg alle views. */
function hideAllViews() {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
}

/** Toon één specifieke view. */
function showView(viewId) {
  hideAllViews();
  const el = document.getElementById(viewId);
  if (el) el.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Toon de voortgangsbalk in de header. */
function updateProgressBar() {
  const bar   = document.getElementById('round-progress-bar');
  const fill  = document.getElementById('round-progress-fill');
  const label = document.getElementById('round-progress-label');
  if (!bar) return;

  if (state.phase === 'lobby' || state.phase === 'stats') {
    bar.style.display = 'none';
    return;
  }

  bar.style.display  = 'block';
  const pct          = ((state.currentRound + 1) / TOTAL_ROUNDS) * 100;
  fill.style.width   = `${pct}%`;
  label.textContent  = `Ronde ${state.currentRound + 1} / ${TOTAL_ROUNDS}`;
}

/** Toon de "terug naar lobby" knop in de header. */
function updateHomeButton() {
  const btn = document.getElementById('btn-home');
  if (btn) {
    btn.style.display = state.phase !== 'lobby' ? 'flex' : 'none';
  }
}

/**
 * Toon een toast notificatie.
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 * @param {number} duration - ms
 */
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  const toast     = document.createElement('div');
  toast.className = `toast ${type}`;

  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  toast.innerHTML = `<span>${icons[type] ?? 'ℹ'}</span><span>${message}</span>`;
  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('fade-out');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}

/** Toon of verberg de loading overlay. */
function setLoading(visible) {
  const overlay = document.getElementById('loading-overlay');
  if (visible) {
    overlay.classList.remove('hidden');
  } else {
    overlay.classList.add('hidden');
  }
}

/** Initialen voor avatar. */
function getInitials(name) {
  return name.trim().split(' ')
    .map(w => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
}

/** Formatteer een score met teken en kleur-class. */
function formatScore(score) {
  if (score === null || score === undefined) return '—';
  const cls = score > 0 ? 'pos' : score < 0 ? 'neg' : '';
  const sign = score > 0 ? '+' : '';
  return `<span class="cell-score ${cls}">${sign}${score}</span>`;
}

/* ════════════════════════════════════════════════════════════════
   VIEW: LOBBY
   ════════════════════════════════════════════════════════════════ */

function renderLobby() {
  state.phase           = 'lobby';
  state.selectedPlayers = [];
  state.rounds          = [];
  state.currentRound    = 0;
  state.gameId          = null;

  updateProgressBar();
  updateHomeButton();
  showView('view-lobby');
  renderSelectedPlayersList();
  updateStartButton();
}

/** Render de lijst van geselecteerde spelers met up/down knoppen. */
function renderSelectedPlayersList() {
  const list  = document.getElementById('selected-players-list');
  const panel = document.getElementById('selected-players-panel');
  const badge = document.getElementById('player-count-badge');

  if (state.selectedPlayers.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  badge.textContent   = state.selectedPlayers.length;
  list.innerHTML      = '';

  state.selectedPlayers.forEach((player, index) => {
    const li = document.createElement('li');
    li.className = 'player-list-item';
    li.dataset.index = index;

    li.innerHTML = `
      <div class="player-avatar">${getInitials(player.name)}</div>
      <span class="player-name">${player.name}</span>
      <button class="player-order-btn" data-action="up" data-idx="${index}"
              ${index === 0 ? 'disabled' : ''} aria-label="Omhoog">▲</button>
      <button class="player-order-btn" data-action="down" data-idx="${index}"
              ${index === state.selectedPlayers.length - 1 ? 'disabled' : ''} aria-label="Omlaag">▼</button>
      <button class="player-remove-btn" data-action="remove" data-idx="${index}"
              aria-label="Verwijder ${player.name}">✕</button>
    `;
    list.appendChild(li);
  });

  // Event delegation voor order knoppen
  list.onclick = (e) => {
    const btn    = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const idx    = parseInt(btn.dataset.idx, 10);

    if (action === 'up' && idx > 0) {
      [state.selectedPlayers[idx - 1], state.selectedPlayers[idx]] =
        [state.selectedPlayers[idx], state.selectedPlayers[idx - 1]];
      renderSelectedPlayersList();
    } else if (action === 'down' && idx < state.selectedPlayers.length - 1) {
      [state.selectedPlayers[idx], state.selectedPlayers[idx + 1]] =
        [state.selectedPlayers[idx + 1], state.selectedPlayers[idx]];
      renderSelectedPlayersList();
    } else if (action === 'remove') {
      state.selectedPlayers.splice(idx, 1);
      renderSelectedPlayersList();
    }
    updateStartButton();
  };
}

function updateStartButton() {
  const btn = document.getElementById('btn-start-game');
  btn.disabled = state.selectedPlayers.length < 2;
}

/** Autocomplete dropdown logica voor speler zoeken. */
function setupPlayerSearch() {
  const input    = document.getElementById('player-search-input');
  const dropdown = document.getElementById('player-autocomplete');
  const hint     = document.getElementById('add-player-hint');
  const addBtn   = document.getElementById('btn-add-player');

  let currentQuery = '';

  input.addEventListener('input', () => {
    currentQuery = input.value.trim();
    hint.textContent = '';

    if (!currentQuery) {
      dropdown.classList.remove('open');
      dropdown.innerHTML = '';
      return;
    }

    // Filter spelers op naam
    const matches = state.allPlayers.filter(p =>
      p.name.toLowerCase().includes(currentQuery.toLowerCase())
    );

    // Verwijder al geselecteerde spelers
    const filtered = matches.filter(p =>
      !state.selectedPlayers.some(s => s.id === p.id)
    );

    dropdown.innerHTML = '';

    if (filtered.length > 0) {
      filtered.slice(0, 8).forEach(player => {
        const item = document.createElement('div');
        item.className    = 'autocomplete-item';
        item.textContent  = player.name;
        item.setAttribute('role', 'option');
        item.addEventListener('click', () => {
          addSelectedPlayer(player);
          input.value = '';
          dropdown.classList.remove('open');
          dropdown.innerHTML = '';
        });
        dropdown.appendChild(item);
      });
    }

    // "Nieuwe speler toevoegen" optie
    const exactMatch = state.allPlayers.some(
      p => p.name.toLowerCase() === currentQuery.toLowerCase()
    );
    if (!exactMatch && currentQuery.length >= 2) {
      const newItem     = document.createElement('div');
      newItem.className = 'autocomplete-item autocomplete-item-new';
      newItem.innerHTML = `✚ Nieuwe speler: <strong>${currentQuery}</strong>`;
      newItem.addEventListener('click', () => {
        createAndAddPlayer(currentQuery);
        input.value = '';
        dropdown.classList.remove('open');
        dropdown.innerHTML = '';
      });
      dropdown.appendChild(newItem);
    }

    dropdown.classList.toggle('open', dropdown.children.length > 0);
  });

  // Klik buiten dropdown → sluit
  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });

  // Enter in zoekveld → voeg toe
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && currentQuery.length >= 2) {
      const firstItem = dropdown.querySelector('.autocomplete-item');
      if (firstItem) firstItem.click();
    }
  });

  // + Toevoegen knop
  addBtn.addEventListener('click', () => {
    if (currentQuery.length >= 2) {
      const exactPlayer = state.allPlayers.find(
        p => p.name.toLowerCase() === currentQuery.toLowerCase()
      );
      if (exactPlayer && !state.selectedPlayers.some(s => s.id === exactPlayer.id)) {
        addSelectedPlayer(exactPlayer);
      } else if (!exactPlayer) {
        createAndAddPlayer(currentQuery);
      }
      input.value = '';
      dropdown.classList.remove('open');
    }
  });
}

function addSelectedPlayer(player) {
  if (state.selectedPlayers.length >= 7) {
    showToast('Maximum 7 spelers bereikt', 'error');
    return;
  }
  if (state.selectedPlayers.some(s => s.id === player.id)) {
    showToast(`${player.name} is al toegevoegd`, 'error');
    return;
  }
  state.selectedPlayers.push(player);
  renderSelectedPlayersList();
  updateStartButton();
  showToast(`${player.name} toegevoegd`, 'success', 1500);
}

async function createAndAddPlayer(name) {
  try {
    setLoading(true);
    const newPlayer = await addPlayer(name);
    state.allPlayers.push(newPlayer);
    state.allPlayers.sort((a, b) => a.name.localeCompare(b.name));
    addSelectedPlayer(newPlayer);
    showToast(`'${name}' aangemaakt en toegevoegd`, 'success');
  } catch (err) {
    showToast(`Fout: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

/* ════════════════════════════════════════════════════════════════
   SPEL STARTEN
   ════════════════════════════════════════════════════════════════ */

async function startGame() {
  if (state.selectedPlayers.length < 2) return;

  try {
    setLoading(true);

    // Willekeurige beginspeler
    state.startPlayerIndex = Math.floor(Math.random() * state.selectedPlayers.length);
    state.currentRound     = 0;
    state.rounds           = [];

    // Maak spel-document in Firestore
    const names  = state.selectedPlayers.map(p => p.name);
    state.gameId = await createGame(names);

    showToast(`Spel gestart! ${state.selectedPlayers[state.startPlayerIndex].name} begint.`, 'success');
    startBiddingPhase();

  } catch (err) {
    showToast(`Kon spel niet starten: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

/* ════════════════════════════════════════════════════════════════
   VIEW: BIEDEN
   ════════════════════════════════════════════════════════════════ */

function startBiddingPhase() {
  state.phase = 'bidding';

  const roundIndex  = state.currentRound;
  const cards       = CARDS_PER_ROUND[roundIndex];
  const { firstBidderIndex, dealerIndex } = getBiddingOrder(roundIndex);

  // Initialiseer ronde-data als die nog niet bestaat
  if (!state.rounds[roundIndex]) {
    state.rounds[roundIndex] = {
      roundIndex,
      cards,
      dealerIndex,
      firstBidderIndex,
      playerData: {}
    };
    state.selectedPlayers.forEach(p => {
      state.rounds[roundIndex].playerData[p.name] = {
        bid:    null,
        tricks: null,
        score:  null
      };
    });
  }

  updateProgressBar();
  updateHomeButton();
  showView('view-bidding');
  renderBiddingView(cards, dealerIndex, firstBidderIndex);
}

/**
 * Render de bied-view.
 * Per speler: een header met naam + dealer-tag, het geselecteerde bod,
 * en een number pad (0 t/m cards knoppen).
 *
 * De "dealer beperking" wordt toegepast op de LAATSTE bieder:
 * - Als alle andere spelers geboden hebben, bereken het verboden bod
 * - Zet de betreffende knop op disabled + rode stijl
 */
function renderBiddingView(cards, dealerIndex, firstBidderIndex) {
  const n          = state.selectedPlayers.length;
  const container  = document.getElementById('bidding-players-container');
  container.innerHTML = '';

  // Bepaal bied-volgorde (beginspeler → klokwise)
  const biddingOrder = [];
  for (let i = 0; i < n; i++) {
    biddingOrder.push((firstBidderIndex + i) % n);
  }
  // De dealer is de laatste in de bied-volgorde
  const dealerBidOrder = biddingOrder[biddingOrder.length - 1];

  // Render een kaart per speler in bied-volgorde
  biddingOrder.forEach((playerIndex, orderPosition) => {
    const player     = state.selectedPlayers[playerIndex];
    const isDealer   = (playerIndex === dealerIndex);
    const isFirst    = (orderPosition === 0);
    const roundData  = state.rounds[state.currentRound];
    const currentBid = roundData.playerData[player.name].bid;

    const card = document.createElement('div');
    card.className = `bidding-player-card${isDealer ? ' is-dealer' : ''}${currentBid !== null ? ' is-done' : ''}`;
    card.dataset.playerName = player.name;
    card.dataset.playerIndex = playerIndex;

    // Bouw number pad knoppen (0 t/m cards)
    const numBtns = [];
    for (let i = 0; i <= cards; i++) {
      numBtns.push(`
        <button class="num-btn${currentBid === i ? ' selected' : ''}"
                data-value="${i}"
                data-player="${player.name}"
                aria-label="Bod ${i}">
          ${i}
        </button>
      `);
    }

    card.innerHTML = `
      <div class="bidding-player-header">
        <div class="player-avatar">${getInitials(player.name)}</div>
        <span class="bidding-player-name">${player.name}</span>
        ${isDealer ? '<span class="dealer-tag">Gever ♦</span>' : ''}
        ${isFirst  ? '<span class="first-tag">Eerste bieder</span>' : ''}
      </div>
      <div class="bid-selected-display" id="bid-display-${playerIndex}">
        ${currentBid !== null
          ? currentBid
          : '<span class="placeholder">— kies bod —</span>'}
      </div>
      <div class="number-pad" id="numpad-${playerIndex}">
        ${numBtns.join('')}
      </div>
    `;

    container.appendChild(card);
  });

  // Zet event listeners op alle number-pad knoppen via delegation
  container.addEventListener('click', onBidButtonClick);

  // Update het initiële totaal en dealer-beperking
  updateBiddingTotals();
}

/**
 * Handler voor klikken op een bod-knop.
 * Update de state en herrendert de relevante UI elementen.
 */
function onBidButtonClick(e) {
  const btn = e.target.closest('.num-btn');
  if (!btn || btn.disabled || btn.classList.contains('forbidden')) return;

  const playerName = btn.dataset.player;
  const bidValue   = parseInt(btn.dataset.value, 10);

  // Sla bid op in state
  state.rounds[state.currentRound].playerData[playerName].bid = bidValue;

  // Update visueel: markeer geselecteerde knop + display
  const card       = btn.closest('.bidding-player-card');
  const playerIndex = parseInt(card.dataset.playerIndex, 10);

  card.querySelectorAll('.num-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');

  const display = document.getElementById(`bid-display-${playerIndex}`);
  if (display) display.textContent = bidValue;
  card.classList.add('is-done');

  updateBiddingTotals();
}

/**
 * Update de "totaal geboden" teller en de dealer-beperking.
 *
 * DEALER BEPERKING FLOW:
 * 1. Verzamel de biedingen van alle niet-dealers.
 * 2. Bereken het verboden bod voor de dealer.
 * 3. Zet de betreffende knop op disabled + 'forbidden' class.
 * 4. Toon of verberg de waarschuwing.
 * 5. Update de "Biedingen Bevestigen" knop (disabled als niet iedereen geboden heeft).
 */
function updateBiddingTotals() {
  const roundData       = state.rounds[state.currentRound];
  const cards           = CARDS_PER_ROUND[state.currentRound];
  const n               = state.selectedPlayers.length;
  const { dealerIndex } = getBiddingOrder(state.currentRound);
  const dealerName      = state.selectedPlayers[dealerIndex].name;

  // Bereken totaal geboden slagen (exclusief dealer als die nog niet geboden heeft)
  let totalBids    = 0;
  let allBidsDone  = true;
  const nonDealerBids = [];

  state.selectedPlayers.forEach((player, idx) => {
    const bid = roundData.playerData[player.name].bid;
    if (bid === null) {
      allBidsDone = false;
    } else {
      totalBids += bid;
      if (idx !== dealerIndex) {
        nonDealerBids.push(bid);
      }
    }
  });

  // Update totaal display
  const totalDisplay = document.getElementById('bid-total-display');
  if (totalDisplay) {
    totalDisplay.textContent = totalBids;
    // Kleurcodering: groen = onder, rood = boven/gelijk
    if (totalBids < cards)  totalDisplay.className = 'info-value text-positive';
    else if (totalBids === cards) totalDisplay.className = 'info-value text-negative';
    else                    totalDisplay.className = 'info-value text-negative';
  }

  // Update round info labels
  document.getElementById('bid-round-number').textContent = state.currentRound + 1;
  document.getElementById('bid-cards-count').textContent  = cards;

  // ── DEALER BEPERKING ──
  // Het verboden bod is alleen relevant als de dealer nog NIET geboden heeft
  // én alle andere spelers al wel geboden hebben.
  const dealerBid     = roundData.playerData[dealerName].bid;
  const othersAllDone = state.selectedPlayers.every((p, i) =>
    i === dealerIndex || roundData.playerData[p.name].bid !== null
  );

  const warning = document.getElementById('dealer-restriction-warning');

  if (othersAllDone && dealerBid === null) {
    // Bereken het verboden bod op basis van de niet-dealer biedingen
    const forbiddenBid = calculateForbiddenBid(cards, nonDealerBids);

    if (forbiddenBid !== null) {
      // Toon waarschuwing
      document.getElementById('forbidden-bid-value').textContent = forbiddenBid;
      warning.style.display = 'flex';

      // Zet de verboden knop op disabled in de dealer-kaart
      applyDealerRestriction(dealerName, dealerIndex, forbiddenBid);
    } else {
      warning.style.display = 'none';
      clearDealerRestriction(dealerIndex);
    }
  } else {
    warning.style.display = 'none';
    // Reset restriction als dealer al geboden heeft
    if (dealerBid !== null) {
      clearDealerRestriction(dealerIndex);
    }
  }

  // Update "Bevestigen" knop
  const confirmBtn = document.getElementById('btn-confirm-bids');
  if (confirmBtn) {
    confirmBtn.disabled = !allBidsDone;
  }
}

/**
 * Voeg de "forbidden" class toe aan de verboden bod-knop van de dealer.
 * @param {string} dealerName
 * @param {number} dealerIndex
 * @param {number} forbiddenBid
 */
function applyDealerRestriction(dealerName, dealerIndex, forbiddenBid) {
  const container = document.getElementById('bidding-players-container');
  if (!container) return;

  // Vind de kaart van de dealer
  const dealerCard = container.querySelector(`[data-player-index="${dealerIndex}"]`);
  if (!dealerCard) return;

  // Reset eerst alle knoppen in de dealer-kaart
  dealerCard.querySelectorAll('.num-btn').forEach(btn => {
    btn.classList.remove('forbidden');
    btn.disabled = false;
  });

  // Zet verboden bod op disabled + forbidden class
  const forbiddenBtn = dealerCard.querySelector(`.num-btn[data-value="${forbiddenBid}"]`);
  if (forbiddenBtn) {
    forbiddenBtn.classList.add('forbidden');
    forbiddenBtn.disabled = true;
    forbiddenBtn.title    = `Verboden bod: ${forbiddenBid} (maakt totaal gelijk aan kaarten)`;
  }
}

function clearDealerRestriction(dealerIndex) {
  const container = document.getElementById('bidding-players-container');
  if (!container) return;
  const dealerCard = container.querySelector(`[data-player-index="${dealerIndex}"]`);
  if (!dealerCard) return;
  dealerCard.querySelectorAll('.num-btn').forEach(btn => {
    btn.classList.remove('forbidden');
    btn.disabled = false;
  });
}

/* ════════════════════════════════════════════════════════════════
   VIEW: RESULTATEN
   ════════════════════════════════════════════════════════════════ */

function startResultsPhase() {
  state.phase = 'results';

  // Verwijder de bidding event listener
  const biddingContainer = document.getElementById('bidding-players-container');
  biddingContainer.removeEventListener('click', onBidButtonClick);

  showView('view-results');
  renderResultsView();
}

/**
 * Render de resultaten-invoer view.
 * Per speler: een teller met + / − knoppen.
 * De "Opslaan" knop is alleen actief als som(tricks) === cards.
 */
function renderResultsView() {
  const roundData  = state.rounds[state.currentRound];
  const cards      = CARDS_PER_ROUND[state.currentRound];
  const container  = document.getElementById('results-players-container');
  container.innerHTML = '';

  // Initialiseer tricks op 0
  state.selectedPlayers.forEach(player => {
    if (roundData.playerData[player.name].tricks === null) {
      roundData.playerData[player.name].tricks = 0;
    }
  });

  state.selectedPlayers.forEach((player, index) => {
    const bid    = roundData.playerData[player.name].bid;
    const tricks = roundData.playerData[player.name].tricks;

    const card = document.createElement('div');
    card.className = 'result-player-card';
    card.dataset.playerName = player.name;

    card.innerHTML = `
      <div class="result-player-header">
        <div class="player-avatar">${getInitials(player.name)}</div>
        <span class="result-player-name">${player.name}</span>
        <span class="bid-label">Geboden: <span class="bid-value">${bid}</span></span>
      </div>
      <div class="tricks-input-row">
        <button class="tricks-counter-btn" data-action="dec" data-player="${player.name}"
                ${tricks <= 0 ? 'disabled' : ''} aria-label="Minus één slag">−</button>
        <div class="tricks-value-display" id="tricks-display-${index}">${tricks}</div>
        <button class="tricks-counter-btn" data-action="inc" data-player="${player.name}"
                ${tricks >= cards ? 'disabled' : ''} aria-label="Plus één slag">+</button>
      </div>
      <div class="score-preview" id="score-preview-${index}">
        ${getScorePreviewHTML(bid, tricks)}
      </div>
    `;
    container.appendChild(card);
  });

  // Event delegation
  container.addEventListener('click', onTricksButtonClick);

  updateResultsTotal();
}

function getScorePreviewHTML(bid, tricks) {
  if (bid === null || tricks === null) return '';
  const score = calculateRoundScore(bid, tricks);
  const cls   = score >= 0 ? 'positive' : 'negative';
  const sign  = score > 0 ? '+' : '';
  return `Score: <span class="${cls}">${sign}${score} pts</span>`;
}

function onTricksButtonClick(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;

  const action     = btn.dataset.action;
  const playerName = btn.dataset.player;
  const roundData  = state.rounds[state.currentRound];
  const cards      = CARDS_PER_ROUND[state.currentRound];
  let   tricks     = roundData.playerData[playerName].tricks;

  if (action === 'dec' && tricks > 0)      tricks--;
  else if (action === 'inc' && tricks < cards) tricks++;
  else return;

  roundData.playerData[playerName].tricks = tricks;

  // Update display voor deze speler
  const playerIndex = state.selectedPlayers.findIndex(p => p.name === playerName);
  const display     = document.getElementById(`tricks-display-${playerIndex}`);
  const preview     = document.getElementById(`score-preview-${playerIndex}`);
  const bid         = roundData.playerData[playerName].bid;

  if (display) display.textContent = tricks;
  if (preview) preview.innerHTML   = getScorePreviewHTML(bid, tricks);

  // Update dec/inc disabled state
  btn.closest('.result-player-card').querySelector('[data-action="dec"]').disabled = tricks <= 0;
  btn.closest('.result-player-card').querySelector('[data-action="inc"]').disabled = tricks >= cards;

  updateResultsTotal();
}

/**
 * Update het totaal-display en de validatiestatus.
 * De "Opslaan" knop is alleen actief als sum(tricks) === cards.
 */
function updateResultsTotal() {
  const roundData  = state.rounds[state.currentRound];
  const cards      = CARDS_PER_ROUND[state.currentRound];
  const sumTricks  = state.selectedPlayers.reduce((sum, p) =>
    sum + (roundData.playerData[p.name].tricks ?? 0), 0);

  const totalDisplay = document.getElementById('res-total-display');
  if (totalDisplay) totalDisplay.textContent = `${sumTricks} / ${cards}`;

  document.getElementById('res-round-number').textContent = state.currentRound + 1;
  document.getElementById('res-cards-count').textContent  = cards;

  const validMsg  = document.getElementById('results-validation-msg');
  const saveBtn   = document.getElementById('btn-save-round');
  const isValid   = sumTricks === cards;

  if (isValid) {
    validMsg.style.display = 'none';
    saveBtn.disabled       = false;
  } else {
    const diff = cards - sumTricks;
    validMsg.className     = 'alert alert-warning';
    validMsg.innerHTML     = `<span class="alert-icon">⚠</span>
      Totaal slagen (${sumTricks}) ≠ kaarten (${cards}).
      ${diff > 0 ? `Nog ${diff} slag(en) te verdelen.` : `${Math.abs(diff)} slag(en) te veel.`}`;
    validMsg.style.display = 'flex';
    saveBtn.disabled       = true;
  }
}

/* ════════════════════════════════════════════════════════════════
   RONDE OPSLAAN
   ════════════════════════════════════════════════════════════════ */

async function saveRound() {
  const roundData = state.rounds[state.currentRound];
  const cards     = CARDS_PER_ROUND[state.currentRound];

  // Bereken scores voor deze ronde
  state.selectedPlayers.forEach(player => {
    const data = roundData.playerData[player.name];
    data.score = calculateRoundScore(data.bid, data.tricks);
  });

  // Verwijder results event listener
  const resContainer = document.getElementById('results-players-container');
  resContainer.removeEventListener('click', onTricksButtonClick);

  // Sla op in Firestore
  try {
    await saveGameRounds(state.gameId, state.rounds);
  } catch (err) {
    showToast(`Opslaan mislukt: ${err.message}`, 'error');
  }

  // Ga naar scorebord
  state.phase = 'scoreboard';
  renderScoreboard();
}

/* ════════════════════════════════════════════════════════════════
   VIEW: SCOREBORD
   ════════════════════════════════════════════════════════════════ */

/**
 * Render het scorebord als een tabel:
 * - Kolom 1: Ronde (+ kaarten)
 * - Per speler: bod | slagen | score | cumulatief
 *
 * De tabel ondersteunt een "edit modus" waarbij op cellen geklikt kan worden.
 */
function renderScoreboard() {
  state.phase = 'scoreboard';
  updateProgressBar();
  updateHomeButton();
  showView('view-scoreboard');

  const playerNames = state.selectedPlayers.map(p => p.name);
  const isLastRound = state.currentRound === TOTAL_ROUNDS - 1;

  // Titel
  document.getElementById('scoreboard-title').textContent =
    isLastRound ? '🏆 Eindscores' : `Scorebord na ronde ${state.currentRound + 1}`;

  // Toon volgende/afsluiten knop
  document.getElementById('btn-next-round').style.display  = isLastRound ? 'none'  : 'inline-flex';
  document.getElementById('btn-finish-game').style.display = isLastRound ? 'inline-flex' : 'none';

  const thead = document.getElementById('scoreboard-thead');
  const tbody = document.getElementById('scoreboard-tbody');
  const tfoot = document.getElementById('scoreboard-tfoot');

  // ── HEADER ──
  // Ronde | [Speler: bod | slagen | score | ∑] per speler
  let headerHTML = '<tr><th>Ronde</th>';
  playerNames.forEach(name => {
    headerHTML += `<th colspan="4" style="border-left:2px solid var(--border)">
      <div class="player-avatar" style="margin:0 auto;width:28px;height:28px;font-size:0.75rem;">
        ${getInitials(name)}
      </div>
      <div style="font-size:0.8rem;margin-top:2px;">${name}</div>
    </th>`;
  });
  headerHTML += '</tr>';

  // Sub-header rij
  headerHTML += '<tr><th></th>';
  playerNames.forEach(() => {
    headerHTML += '<th style="border-left:2px solid var(--border);">Bod</th><th>Slagen</th><th>Score</th><th>∑</th>';
  });
  headerHTML += '</tr>';
  thead.innerHTML = headerHTML;

  // ── BODY ──
  // Cumulatieve scores bijhouden per speler tijdens het renderen
  const cumulative = {};
  playerNames.forEach(name => cumulative[name] = 0);

  let bodyHTML = '';
  for (let ri = 0; ri <= state.currentRound; ri++) {
    const round  = state.rounds[ri];
    if (!round) continue;
    const cards  = CARDS_PER_ROUND[ri];
    const isCur  = ri === state.currentRound;

    bodyHTML += `<tr class="${isCur ? 'current-round' : ''}">`;
    bodyHTML += `<td><strong>${ri + 1}</strong><br><span style="font-size:0.72rem;color:var(--text-muted);">${cards}♦</span></td>`;

    playerNames.forEach(name => {
      const data  = round.playerData?.[name];
      const bid   = data?.bid    ?? null;
      const tricks= data?.tricks ?? null;
      const score = data?.score  ?? null;

      if (score !== null) cumulative[name] += score;

      const bidCell    = bid    !== null ? bid    : '—';
      const tricksCell = tricks !== null ? tricks : '—';
      const scoreCell  = score  !== null ? formatScore(score) : '—';
      const cumCell    = score  !== null
        ? `<span class="cell-cumulative ${cumulative[name] >= 0 ? 'text-gold' : 'text-negative'}">${cumulative[name]}</span>`
        : '—';

      // Edit-modus data attributen voor correctie
      bodyHTML += `
        <td style="border-left:2px solid var(--border);"
            class="cell-bid editable"
            data-round="${ri}" data-player="${name}" data-field="bid">${bidCell}</td>
        <td class="editable"
            data-round="${ri}" data-player="${name}" data-field="tricks">${tricksCell}</td>
        <td>${scoreCell}</td>
        <td>${cumCell}</td>
      `;
    });
    bodyHTML += '</tr>';
  }
  tbody.innerHTML = bodyHTML;

  // ── FOOTER (totaalscores) ──
  const totals = calculateCumulativeScores(playerNames, state.rounds);
  let footHTML = '<tr><td>Totaal</td>';
  playerNames.forEach(name => {
    const total = totals[name];
    const cls   = total >= 0 ? 'text-gold' : 'text-negative';
    footHTML += `<td colspan="4" style="border-left:2px solid var(--border);">
      <span class="${cls}">${total}</span>
    </td>`;
  });
  footHTML += '</tr>';
  tfoot.innerHTML = footHTML;

  // Pas edit modus toe
  applyEditMode();
}

/* ════════════════════════════════════════════════════════════════
   EDIT MODUS & CORRECTIES
   ════════════════════════════════════════════════════════════════ */

function applyEditMode() {
  const table = document.getElementById('scoreboard-table');
  if (state.isEditMode) {
    table.classList.add('edit-mode');
    table.querySelectorAll('.editable').forEach(cell => {
      cell.style.cursor = 'pointer';
    });
  } else {
    table.classList.remove('edit-mode');
    table.querySelectorAll('.editable').forEach(cell => {
      cell.style.cursor = '';
    });
  }
}

/** Toggle edit modus aan/uit. */
function toggleEditMode() {
  state.isEditMode = !state.isEditMode;
  const banner = document.getElementById('edit-mode-banner');
  const btn    = document.getElementById('btn-toggle-edit');

  banner.style.display = state.isEditMode ? 'flex' : 'none';
  btn.textContent      = state.isEditMode ? '✓ Klaar' : '✏ Bewerken';

  applyEditMode();
}

/**
 * Behandel een klik op een bewerkbare cel in het scorebord.
 *
 * CORRECTIE FLOW:
 * 1. Bepaal welke ronde, speler en veld (bid/tricks) aangeklikt zijn.
 * 2. Toon de edit modal met de huidige waarde.
 * 3. Na bevestiging:
 *    a. Pas de waarde aan in state.rounds.
 *    b. Roep recalculateFromRound(roundIndex) aan om scores te herberekenen.
 *    c. Sla op in Firestore.
 *    d. Herrender het scorebord.
 */
function handleScoreboardCellClick(e) {
  if (!state.isEditMode) return;
  const cell = e.target.closest('.editable');
  if (!cell) return;

  const roundIndex = parseInt(cell.dataset.round, 10);
  const playerName = cell.dataset.player;
  const field      = cell.dataset.field; // 'bid' | 'tricks'

  const round  = state.rounds[roundIndex];
  const cards  = CARDS_PER_ROUND[roundIndex];
  const data   = round.playerData[playerName];
  const currentValue = data[field] ?? 0;

  // Dealer-beperking info voor de modal
  let dealerWarning = null;
  if (field === 'bid') {
    // Bereken het verboden bod op basis van de andere biedingen in die ronde
    const { dealerIndex } = getBiddingOrder(roundIndex);
    const isDealerPlayer  = state.selectedPlayers[dealerIndex].name === playerName;
    if (isDealerPlayer) {
      const otherBids = state.selectedPlayers
        .filter(p => p.name !== playerName)
        .map(p => round.playerData[p.name].bid ?? 0);
      const forbidden = calculateForbiddenBid(cards, otherBids);
      if (forbidden !== null) {
        dealerWarning = `Let op: ${forbidden} is het verboden bod (dealer-beperking).`;
      }
    }
  }

  openEditModal({
    title:        `Corrigeer ${field === 'bid' ? 'bod' : 'slagen'} — ${playerName}`,
    description:  `Ronde ${roundIndex + 1} (${cards} kaarten). Huidige waarde: ${currentValue}`,
    currentValue,
    min:          0,
    max:          cards,
    warning:      dealerWarning,
    onSave:       async (newValue) => {
      // Pas waarde aan in state
      data[field] = newValue;

      // Als tricks gewijzigd → ook bij bid-checks
      if (field === 'tricks') {
        // Valideer: som tricks moet nog steeds kloppen voor die ronde
        const sumTricks = state.selectedPlayers.reduce((sum, p) =>
          sum + (round.playerData[p.name].tricks ?? 0), 0);
        if (sumTricks !== cards) {
          showToast(`Som slagen (${sumTricks}) ≠ kaarten (${cards}). Pas ook andere spelers aan.`, 'error', 5000);
        }
      }

      /**
       * HERBEREKENING NA CORRECTIE:
       * We herberekenen scores voor alle rondes vanaf de gecorrigeerde ronde.
       * Omdat de cumulatieve scores afgeleid zijn van de rondescore-array,
       * zijn alle latere cumulatieve totalen automatisch correct na deze call.
       */
      recalculateFromRound(roundIndex);

      // Sla op in Firestore
      try {
        await saveGameRounds(state.gameId, state.rounds);
        showToast('Correctie opgeslagen', 'success');
      } catch (err) {
        showToast(`Opslaan mislukt: ${err.message}`, 'error');
      }

      // Herrender scorebord
      renderScoreboard();
    }
  });
}

/* ════════════════════════════════════════════════════════════════
   EDIT MODAL
   ════════════════════════════════════════════════════════════════ */

function openEditModal({ title, description, currentValue, min, max, warning, onSave }) {
  const modal   = document.getElementById('edit-modal');
  const input   = document.getElementById('edit-value-input');
  const warnEl  = document.getElementById('edit-modal-warning');
  const decBtn  = document.getElementById('edit-dec');
  const incBtn  = document.getElementById('edit-inc');

  document.getElementById('edit-modal-title').textContent = title;
  document.getElementById('edit-modal-desc').textContent  = description;
  input.value = currentValue;
  input.min   = min;
  input.max   = max;

  if (warning) {
    warnEl.textContent     = warning;
    warnEl.style.display   = 'block';
  } else {
    warnEl.style.display   = 'none';
  }

  modal.style.display = 'flex';

  const updateBtns = () => {
    const v  = parseInt(input.value, 10);
    decBtn.disabled = v <= min;
    incBtn.disabled = v >= max;
  };
  updateBtns();

  // Kloon knoppen om event listeners te wissen
  const newDecBtn = decBtn.cloneNode(true);
  const newIncBtn = incBtn.cloneNode(true);
  decBtn.parentNode.replaceChild(newDecBtn, decBtn);
  incBtn.parentNode.replaceChild(newIncBtn, incBtn);

  newDecBtn.addEventListener('click', () => {
    const v = parseInt(input.value, 10);
    if (v > min) { input.value = v - 1; updateBtns(); }
  });
  newIncBtn.addEventListener('click', () => {
    const v = parseInt(input.value, 10);
    if (v < max) { input.value = v + 1; updateBtns(); }
  });
  input.addEventListener('input', updateBtns);

  // Cancel
  document.getElementById('edit-modal-cancel').onclick = () => {
    modal.style.display = 'none';
  };

  // Save
  document.getElementById('edit-modal-save').onclick = async () => {
    const newValue = parseInt(input.value, 10);
    if (isNaN(newValue) || newValue < min || newValue > max) {
      showToast(`Waarde moet tussen ${min} en ${max} liggen`, 'error');
      return;
    }
    modal.style.display = 'none';
    await onSave(newValue);
  };

  // Klik buiten modal → sluit
  modal.onclick = (e) => {
    if (e.target === modal) modal.style.display = 'none';
  };
}

/* ════════════════════════════════════════════════════════════════
   VOLGENDE RONDE / SPEL AFSLUITEN
   ════════════════════════════════════════════════════════════════ */

function goToNextRound() {
  state.currentRound++;
  state.isEditMode = false;
  document.getElementById('edit-mode-banner').style.display = 'none';
  startBiddingPhase();
}

/**
 * Sluit het spel af na de laatste ronde.
 * Berekent eindrangorde en slaat het spel op als 'completed'.
 */
async function finishGame() {
  try {
    setLoading(true);

    const playerNames = state.selectedPlayers.map(p => p.name);
    const totals      = calculateCumulativeScores(playerNames, state.rounds);
    const ranking     = calculateFinalRanking(totals);

    await finalizeGame(state.gameId, state.rounds, ranking);

    showToast('Spel opgeslagen! 🏆', 'success');
    renderStatsView(ranking);

  } catch (err) {
    showToast(`Afsluiten mislukt: ${err.message}`, 'error');
  } finally {
    setLoading(false);
  }
}

/* ════════════════════════════════════════════════════════════════
   VIEW: STATISTIEKEN & EINDSTAND
   ════════════════════════════════════════════════════════════════ */

async function renderStatsView(finalRanking = null) {
  state.phase = 'stats';
  updateProgressBar();
  updateHomeButton();
  showView('view-stats');

  // ── EINDSTAND (indien net afgerond) ──
  const finalSection = document.getElementById('final-results-section');
  if (finalRanking) {
    finalSection.style.display = 'block';
    renderPodium(finalRanking);
    renderFinalScoresList(finalRanking);
  } else {
    finalSection.style.display = 'none';
  }

  // ── GLOBALE RECORDS laden ──
  const recordsContainer = document.getElementById('global-records-container');
  recordsContainer.innerHTML = '<div class="loading-records">Records laden…</div>';

  try {
    const records = await calculateGlobalRecords();
    renderGlobalRecords(records);
    setupStatsPlayerSearch(records);
  } catch (err) {
    recordsContainer.innerHTML = `<p class="text-muted">Records konden niet geladen worden: ${err.message}</p>`;
  }
}

function renderPodium(ranking) {
  const podium = document.getElementById('final-podium');
  podium.innerHTML = '';

  // Sorteer: toon 2e, 1e, 3e (podium volgorde)
  const top3 = ranking.slice(0, 3);
  const order = top3.length >= 3
    ? [top3[1], top3[0], top3[2]]   // 2e, 1e, 3e
    : top3.length === 2
      ? [top3[1], top3[0]]
      : top3;

  const medals = ['🥈', '🥇', '🥉'];

  order.forEach((player, i) => {
    const item = document.createElement('div');
    item.className = 'podium-item';

    const actualIdx = order.length >= 3 ? [1, 0, 2][i] : i;
    const heights   = [80, 110, 60];
    const height    = heights[actualIdx] || 60;

    item.innerHTML = `
      <div class="podium-avatar">${getInitials(player.playerName)}</div>
      <div class="podium-name">${player.playerName}</div>
      <div class="podium-score">${player.totalScore} pts</div>
      <div class="podium-block" style="height:${height}px">${medals[actualIdx] || player.rank}</div>
    `;
    podium.appendChild(item);
  });
}

function renderFinalScoresList(ranking) {
  const list = document.getElementById('final-scores-list');
  list.innerHTML = '';
  ranking.forEach(player => {
    const row = document.createElement('div');
    row.className = 'final-score-row';
    row.innerHTML = `
      <span class="final-rank">#${player.rank}</span>
      <div class="player-avatar">${getInitials(player.playerName)}</div>
      <span class="final-player-name">${player.playerName}</span>
      <span class="final-player-score">${player.totalScore} pts</span>
    `;
    list.appendChild(row);
  });
}

function renderGlobalRecords(records) {
  const container = document.getElementById('global-records-container');
  container.innerHTML = '';

  const formatDate = (d) => d ? new Date(d).toLocaleDateString('nl-NL', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

  const recordDefs = [
    {
      label: '🏆 Hoogste eindscore',
      data:  records.highestFinalScore,
      render: (r) => `${r.value} pts — ${r.playerName}
        <span class="record-meta">${formatDate(r.date)} · getuigen: ${r.witnesses.join(', ') || '—'}</span>`
    },
    {
      label: '💀 Laagste eindscore',
      data:  records.lowestFinalScore,
      render: (r) => `${r.value} pts — ${r.playerName}
        <span class="record-meta">${formatDate(r.date)} · getuigen: ${r.witnesses.join(', ') || '—'}</span>`
    },
    {
      label: '⚡ Hoogste ronde-score',
      data:  records.highestRoundScore,
      render: (r) => `${r.value > 0 ? '+' : ''}${r.value} pts — ${r.playerName}
        <span class="record-meta">Ronde ${r.round} · ${formatDate(r.date)}</span>`
    },
    {
      label: '🔥 Laagste ronde-score',
      data:  records.lowestRoundScore,
      render: (r) => `${r.value} pts — ${r.playerName}
        <span class="record-meta">Ronde ${r.round} · ${formatDate(r.date)}</span>`
    }
  ];

  for (const def of recordDefs) {
    const item = document.createElement('div');
    item.className = 'record-item';
    item.innerHTML = `
      <span class="record-label">${def.label}</span>
      <div class="record-value">${def.data ? def.render(def.data) : '<span class="text-muted">Nog geen data</span>'}</div>
    `;
    container.appendChild(item);
  }
}

function setupStatsPlayerSearch(records) {
  const input    = document.getElementById('stats-player-search');
  const dropdown = document.getElementById('stats-autocomplete');
  const dashboard= document.getElementById('player-stats-dashboard');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    dropdown.innerHTML = '';

    if (!q) {
      dropdown.classList.remove('open');
      return;
    }

    const matches = state.allPlayers.filter(p => p.name.toLowerCase().includes(q));
    matches.slice(0, 8).forEach(player => {
      const item = document.createElement('div');
      item.className   = 'autocomplete-item';
      item.textContent = player.name;
      item.addEventListener('click', () => {
        input.value = player.name;
        dropdown.classList.remove('open');
        renderPlayerDashboard(player.name, records, dashboard);
      });
      dropdown.appendChild(item);
    });
    dropdown.classList.toggle('open', dropdown.children.length > 0);
  });

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.remove('open');
    }
  });
}

function renderPlayerDashboard(playerName, records, container) {
  const stats = records.playerStats?.[playerName];
  container.style.display = 'block';

  if (!stats) {
    container.innerHTML = `<p class="text-muted">Geen voltooide spellen gevonden voor ${playerName}.</p>`;
    return;
  }

  const correctPct = stats.correctPct !== null
    ? `${stats.correctPct.toFixed(1)}%`
    : `${stats.totalGames < 5 ? `(min. 5 spellen)` : '—'}`;

  const avgRank = stats.avgRank !== null
    ? `#${stats.avgRank.toFixed(1)}`
    : `(min. 5 spellen)`;

  const avgScore = stats.avgScore !== null
    ? Math.round(stats.avgScore)
    : '—';

  container.innerHTML = `
    <h4 style="margin-bottom:var(--space-md);font-family:var(--font-display);">${playerName}</h4>
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-value">${stats.totalGames}</div>
        <div class="stat-label">Potjes</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.winCount}</div>
        <div class="stat-label">Gewonnen</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${correctPct}</div>
        <div class="stat-label">Raak %</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${avgRank}</div>
        <div class="stat-label">Gem. plek</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${avgScore}</div>
        <div class="stat-label">Gem. score</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${stats.totalRounds}</div>
        <div class="stat-label">Rondes</div>
      </div>
    </div>
  `;
}

/* ════════════════════════════════════════════════════════════════
   EVENT LISTENERS REGISTRATIE
   ════════════════════════════════════════════════════════════════ */

function registerEventListeners() {
  // ── Dark mode toggle ──
  document.getElementById('btn-dark-mode').addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    const icon = document.querySelector('.icon-moon');
    if (icon) icon.textContent = document.body.classList.contains('dark-mode') ? '☀' : '☾';
  });

  // ── Home knop ──
  document.getElementById('btn-home').addEventListener('click', () => {
    if (confirm('Terug naar de lobby? Het huidige spel wordt niet opgeslagen.')) {
      renderLobby();
    }
  });

  // ── Lobby: spel starten ──
  document.getElementById('btn-start-game').addEventListener('click', startGame);

  // ── Lobby: statistieken ──
  document.getElementById('btn-show-stats').addEventListener('click', () => {
    state.phase = 'stats';
    renderStatsView();
  });

  // ── Bieden: bevestigen ──
  document.getElementById('btn-confirm-bids').addEventListener('click', () => {
    // Controleer of alle biedingen ingevuld zijn
    const roundData = state.rounds[state.currentRound];
    const allDone   = state.selectedPlayers.every(p =>
      roundData.playerData[p.name].bid !== null
    );
    if (!allDone) {
      showToast('Niet alle spelers hebben geboden', 'error');
      return;
    }
    startResultsPhase();
  });

  // ── Resultaten: opslaan ──
  document.getElementById('btn-save-round').addEventListener('click', saveRound);

  // ── Scorebord: edit toggle ──
  document.getElementById('btn-toggle-edit').addEventListener('click', toggleEditMode);

  // ── Scorebord: cel klik (correcties) ──
  document.getElementById('scoreboard-tbody').addEventListener('click', handleScoreboardCellClick);

  // ── Scorebord: volgende ronde ──
  document.getElementById('btn-next-round').addEventListener('click', goToNextRound);

  // ── Scorebord: spel afsluiten ──
  document.getElementById('btn-finish-game').addEventListener('click', finishGame);

  // ── Stats: nieuw spel ──
  document.getElementById('btn-new-game')?.addEventListener('click', renderLobby);

  // ── Stats: terug naar lobby ──
  document.getElementById('btn-stats-to-lobby').addEventListener('click', renderLobby);
}

/* ════════════════════════════════════════════════════════════════
   APP INITIALISATIE
   ════════════════════════════════════════════════════════════════ */

/**
 * Initialiseer de applicatie.
 * - Laad alle spelers uit Firestore
 * - Registreer event listeners
 * - Zet de lobby view klaar
 */
export async function initApp() {
  try {
    // Registreer alle event listeners
    registerEventListeners();

    // Laad alle spelers
    state.allPlayers = await getAllPlayers();

    // Zet de speler-zoekfunctie op
    setupPlayerSearch();

    // Verberg loading overlay
    setLoading(false);

    // Toon de lobby
    renderLobby();

  } catch (err) {
    console.error('App initialisatie mislukt:', err);
    setLoading(false);
    showToast(
      'Verbinding met database mislukt. Controleer je Firebase config.',
      'error',
      8000
    );

    // Toon lobby zonder DB (voor demo/ontwikkeling)
    renderLobby();
  }
}
