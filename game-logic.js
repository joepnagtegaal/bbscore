/**
 * game-logic.js
 * ════════════════════════════════════════════════════════════════
 * Boerenbridge — Core Game Engine & UI Controller
 *
 * STATE MACHINE:  lobby → bidding → results → scoreboard → ...
 *                                            → (laatste ronde) → stats
 *
 * RONDE REEKS:    [1,2,3,4,5,6,7,7,7,6,5,4,3,2,1]  (15 rondes)
 * PUNTEN:         Gehaald: 5 + (2 × slagen)
 *                 Gemist:  -(2 × |bod − slagen|)
 * ════════════════════════════════════════════════════════════════
 */

import {
  getAllPlayers, addPlayer,
  createGame, saveGameRounds, finalizeGame,
  calculateGlobalRecords, generateFunFacts
} from './database-service.js';

/* ════════════════════════════════════════════════════════════════
   CONSTANTEN
   ════════════════════════════════════════════════════════════════ */

const CARDS_PER_ROUND = [1, 2, 3, 4, 5, 6, 7, 7, 7, 6, 5, 4, 3, 2, 1];
const TOTAL_ROUNDS    = 15;

/* ════════════════════════════════════════════════════════════════
   APPLICATIE STATE
   ════════════════════════════════════════════════════════════════ */

let state = {
  phase:            'lobby',
  allPlayers:       [],
  selectedPlayers:  [],
  gameId:           null,
  currentRound:     0,
  startPlayerIndex: 0,
  rounds:           [],
  isEditMode:       false,
  editContext:      null
};

/* ════════════════════════════════════════════════════════════════
   SCORE BEREKENING
   ════════════════════════════════════════════════════════════════ */

function calculateRoundScore(bid, tricks) {
  return bid === tricks
    ? 5 + (2 * tricks)
    : -(2 * Math.abs(bid - tricks));
}

function calculateCumulativeScores(playerNames, rounds) {
  const totals = {};
  playerNames.forEach(n => totals[n] = 0);
  for (const round of rounds) {
    if (!round?.playerData) continue;
    for (const n of playerNames) {
      const d = round.playerData[n];
      if (d?.score !== null && d?.score !== undefined) totals[n] += d.score;
    }
  }
  return totals;
}

/**
 * Herbereken scores van alle rondes vanaf startRoundIndex.
 * Wordt gebruikt na een correctie in edit-modus.
 */
function recalculateFromRound(startRoundIndex) {
  const names = state.selectedPlayers.map(p => p.name);
  for (let i = startRoundIndex; i < state.rounds.length; i++) {
    const round = state.rounds[i];
    if (!round?.playerData) continue;
    for (const name of names) {
      const d = round.playerData[name];
      if (d && d.bid !== null && d.tricks !== null) {
        d.score = calculateRoundScore(d.bid, d.tricks);
      }
    }
  }
}

/* ════════════════════════════════════════════════════════════════
   DEALER BEPERKING
   ════════════════════════════════════════════════════════════════ */

/**
 * Bereken het verboden bod voor de dealer.
 * De dealer mag niet een bod plaatsen waardoor de totale biedingen
 * exact gelijk is aan het aantal kaarten.
 */
function calculateForbiddenBid(cards, existingBids) {
  const sum       = existingBids.reduce((a, b) => a + b, 0);
  const forbidden = cards - sum;
  return (forbidden >= 0 && forbidden <= cards) ? forbidden : null;
}

function getBiddingOrder(roundIndex) {
  const n              = state.selectedPlayers.length;
  const firstBidderIdx = (state.startPlayerIndex + roundIndex) % n;
  const dealerIdx      = (firstBidderIdx + n - 1) % n;
  return { firstBidderIndex: firstBidderIdx, dealerIndex: dealerIdx };
}

/* ════════════════════════════════════════════════════════════════
   EINDKLASSEMENT
   ════════════════════════════════════════════════════════════════ */

function calculateFinalRanking(totals) {
  const sorted = Object.entries(totals)
    .map(([name, score]) => ({ playerName: name, totalScore: score }))
    .sort((a, b) => b.totalScore - a.totalScore);
  let rank = 1;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].totalScore < sorted[i - 1].totalScore) rank = i + 1;
    sorted[i].rank = rank;
  }
  return sorted;
}

/* ════════════════════════════════════════════════════════════════
   DOM HULPFUNCTIES
   ════════════════════════════════════════════════════════════════ */

function hideAllViews() {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
}

function showView(id) {
  hideAllViews();
  document.getElementById(id)?.classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateProgressBar() {
  const bar   = document.getElementById('round-progress-bar');
  const fill  = document.getElementById('round-progress-fill');
  const label = document.getElementById('round-progress-label');
  if (!bar) return;
  if (['lobby', 'stats'].includes(state.phase)) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  fill.style.width  = `${((state.currentRound + 1) / TOTAL_ROUNDS) * 100}%`;
  label.textContent = `Ronde ${state.currentRound + 1} / ${TOTAL_ROUNDS}`;
}

function updateHomeButton() {
  const btn = document.getElementById('btn-home');
  if (btn) btn.style.display = state.phase !== 'lobby' ? 'flex' : 'none';
}

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

function setLoading(visible) {
  document.getElementById('loading-overlay')?.classList.toggle('hidden', !visible);
}

function getInitials(name) {
  return name.trim().split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function formatScore(score) {
  if (score === null || score === undefined) return '—';
  const cls  = score > 0 ? 'pos' : score < 0 ? 'neg' : '';
  const sign = score > 0 ? '+' : '';
  return `<span class="cell-score ${cls}">${sign}${score}</span>`;
}

function fmtDate(date) {
  if (!date) return '—';
  return new Date(date).toLocaleDateString('nl-NL', {
    day: 'numeric', month: 'short', year: 'numeric'
  });
}

/* ════════════════════════════════════════════════════════════════
   VIEW: LOBBY
   ════════════════════════════════════════════════════════════════ */

function renderLobby() {
  Object.assign(state, {
    phase: 'lobby', selectedPlayers: [], rounds: [],
    currentRound: 0, gameId: null, isEditMode: false
  });
  updateProgressBar();
  updateHomeButton();
  showView('view-lobby');
  renderSelectedPlayersList();
  updateStartButton();
}

function renderSelectedPlayersList() {
  const list  = document.getElementById('selected-players-list');
  const panel = document.getElementById('selected-players-panel');
  const badge = document.getElementById('player-count-badge');
  if (!state.selectedPlayers.length) { panel.style.display = 'none'; return; }
  panel.style.display = 'block';
  badge.textContent   = state.selectedPlayers.length;
  list.innerHTML      = '';
  state.selectedPlayers.forEach((player, i) => {
    const li = document.createElement('li');
    li.className = 'player-list-item';
    li.innerHTML = `
      <div class="player-avatar">${getInitials(player.name)}</div>
      <span class="player-name">${player.name}</span>
      <button class="player-order-btn" data-action="up"     data-idx="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Omhoog">▲</button>
      <button class="player-order-btn" data-action="down"   data-idx="${i}" ${i === state.selectedPlayers.length - 1 ? 'disabled' : ''} aria-label="Omlaag">▼</button>
      <button class="player-remove-btn" data-action="remove" data-idx="${i}" aria-label="Verwijder">✕</button>
    `;
    list.appendChild(li);
  });
  list.onclick = e => {
    const btn  = e.target.closest('[data-action]');
    if (!btn) return;
    const act  = btn.dataset.action;
    const idx  = parseInt(btn.dataset.idx, 10);
    const sp   = state.selectedPlayers;
    if      (act === 'up'     && idx > 0)            [sp[idx-1], sp[idx]] = [sp[idx], sp[idx-1]];
    else if (act === 'down'   && idx < sp.length - 1) [sp[idx], sp[idx+1]] = [sp[idx+1], sp[idx]];
    else if (act === 'remove')                         sp.splice(idx, 1);
    renderSelectedPlayersList();
    updateStartButton();
  };
}

function updateStartButton() {
  document.getElementById('btn-start-game').disabled = state.selectedPlayers.length < 2;
}

function setupPlayerSearch() {
  const input    = document.getElementById('player-search-input');
  const dropdown = document.getElementById('player-autocomplete');
  const addBtn   = document.getElementById('btn-add-player');
  let   curQuery = '';

  input.addEventListener('input', () => {
    curQuery = input.value.trim();
    if (!curQuery) { dropdown.classList.remove('open'); dropdown.innerHTML = ''; return; }
    const matches = state.allPlayers
      .filter(p => p.name.toLowerCase().includes(curQuery.toLowerCase()))
      .filter(p => !state.selectedPlayers.some(s => s.id === p.id));
    dropdown.innerHTML = '';
    matches.slice(0, 8).forEach(pl => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.textContent = pl.name;
      item.addEventListener('click', () => { addSelectedPlayer(pl); input.value = ''; dropdown.classList.remove('open'); });
      dropdown.appendChild(item);
    });
    const exactMatch = state.allPlayers.some(p => p.name.toLowerCase() === curQuery.toLowerCase());
    if (!exactMatch && curQuery.length >= 2) {
      const ni = document.createElement('div');
      ni.className = 'autocomplete-item autocomplete-item-new';
      ni.innerHTML = `✚ Nieuwe speler: <strong>${curQuery}</strong>`;
      ni.addEventListener('click', () => { createAndAddPlayer(curQuery); input.value = ''; dropdown.classList.remove('open'); });
      dropdown.appendChild(ni);
    }
    dropdown.classList.toggle('open', dropdown.children.length > 0);
  });
  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) dropdown.classList.remove('open');
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' && curQuery.length >= 2) dropdown.querySelector('.autocomplete-item')?.click();
  });
  addBtn.addEventListener('click', () => {
    if (curQuery.length >= 2) {
      const exact = state.allPlayers.find(p => p.name.toLowerCase() === curQuery.toLowerCase());
      if (exact && !state.selectedPlayers.some(s => s.id === exact.id)) addSelectedPlayer(exact);
      else if (!exact) createAndAddPlayer(curQuery);
      input.value = '';
      dropdown.classList.remove('open');
    }
  });
}

function addSelectedPlayer(player) {
  if (state.selectedPlayers.length >= 7)                          { showToast('Maximum 7 spelers bereikt', 'error'); return; }
  if (state.selectedPlayers.some(s => s.id === player.id))        { showToast(`${player.name} al toegevoegd`, 'error'); return; }
  state.selectedPlayers.push(player);
  renderSelectedPlayersList();
  updateStartButton();
  showToast(`${player.name} toegevoegd`, 'success', 1500);
}

async function createAndAddPlayer(name) {
  try {
    setLoading(true);
    const p = await addPlayer(name);
    state.allPlayers.push(p);
    state.allPlayers.sort((a, b) => a.name.localeCompare(b.name));
    addSelectedPlayer(p);
    showToast(`'${name}' aangemaakt en toegevoegd`, 'success');
  } catch (err) { showToast(`Fout: ${err.message}`, 'error'); }
  finally { setLoading(false); }
}

/* ════════════════════════════════════════════════════════════════
   SPEL STARTEN
   ════════════════════════════════════════════════════════════════ */

async function startGame() {
  if (state.selectedPlayers.length < 2) return;
  try {
    setLoading(true);
    state.startPlayerIndex = Math.floor(Math.random() * state.selectedPlayers.length);
    state.currentRound     = 0;
    state.rounds           = [];
    state.gameId           = await createGame(state.selectedPlayers.map(p => p.name));
    showToast(`${state.selectedPlayers[state.startPlayerIndex].name} begint!`, 'success');
    startBiddingPhase();
  } catch (err) { showToast(`Spel starten mislukt: ${err.message}`, 'error'); }
  finally { setLoading(false); }
}

/* ════════════════════════════════════════════════════════════════
   VIEW: BIEDEN
   ════════════════════════════════════════════════════════════════ */

function startBiddingPhase() {
  state.phase = 'bidding';
  const ri    = state.currentRound;
  const cards = CARDS_PER_ROUND[ri];
  const { firstBidderIndex, dealerIndex } = getBiddingOrder(ri);
  if (!state.rounds[ri]) {
    state.rounds[ri] = { roundIndex: ri, cards, dealerIndex, firstBidderIndex, playerData: {} };
    state.selectedPlayers.forEach(p => {
      state.rounds[ri].playerData[p.name] = { bid: null, tricks: null, score: null };
    });
  }
  updateProgressBar();
  updateHomeButton();
  showView('view-bidding');
  renderBiddingView(cards, dealerIndex, firstBidderIndex);
}

function renderBiddingView(cards, dealerIndex, firstBidderIndex) {
  const n         = state.selectedPlayers.length;
  const container = document.getElementById('bidding-players-container');
  container.innerHTML = '';
  const order = Array.from({ length: n }, (_, i) => (firstBidderIndex + i) % n);

  order.forEach((playerIdx, orderPos) => {
    const player     = state.selectedPlayers[playerIdx];
    const isDealer   = playerIdx === dealerIndex;
    const isFirst    = orderPos === 0;
    const currentBid = state.rounds[state.currentRound].playerData[player.name].bid;

    const card = document.createElement('div');
    card.className = `bidding-player-card${isDealer ? ' is-dealer' : ''}${currentBid !== null ? ' is-done' : ''}`;
    card.dataset.playerName  = player.name;
    card.dataset.playerIndex = playerIdx;

    const btns = Array.from({ length: cards + 1 }, (_, i) =>
      `<button class="num-btn${currentBid === i ? ' selected' : ''}"
               data-value="${i}" data-player="${player.name}" aria-label="Bod ${i}">${i}</button>`
    ).join('');

    card.innerHTML = `
      <div class="bidding-player-header">
        <div class="player-avatar">${getInitials(player.name)}</div>
        <span class="bidding-player-name">${player.name}</span>
        ${isDealer ? '<span class="dealer-tag">Gever ♦</span>' : ''}
        ${isFirst  ? '<span class="first-tag">Eerste bieder</span>' : ''}
      </div>
      <div class="bid-selected-display" id="bid-display-${playerIdx}">
        ${currentBid !== null ? currentBid : '<span class="placeholder">— kies bod —</span>'}
      </div>
      <div class="number-pad" id="numpad-${playerIdx}">${btns}</div>
    `;
    container.appendChild(card);
  });

  container.addEventListener('click', onBidButtonClick);
  updateBiddingTotals();
}

function onBidButtonClick(e) {
  const btn = e.target.closest('.num-btn');
  if (!btn || btn.disabled || btn.classList.contains('forbidden')) return;
  const playerName = btn.dataset.player;
  const bidValue   = parseInt(btn.dataset.value, 10);
  state.rounds[state.currentRound].playerData[playerName].bid = bidValue;
  const card       = btn.closest('.bidding-player-card');
  const playerIdx  = parseInt(card.dataset.playerIndex, 10);
  card.querySelectorAll('.num-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  card.classList.add('is-done');
  const disp = document.getElementById(`bid-display-${playerIdx}`);
  if (disp) disp.textContent = bidValue;
  updateBiddingTotals();
}

function updateBiddingTotals() {
  const round   = state.rounds[state.currentRound];
  const cards   = CARDS_PER_ROUND[state.currentRound];
  const { dealerIndex } = getBiddingOrder(state.currentRound);
  const dealerName = state.selectedPlayers[dealerIndex].name;

  let totalBids = 0, allDone = true;
  const nonDealerBids = [];

  state.selectedPlayers.forEach((p, i) => {
    const bid = round.playerData[p.name].bid;
    if (bid === null) { allDone = false; return; }
    totalBids += bid;
    if (i !== dealerIndex) nonDealerBids.push(bid);
  });

  const td = document.getElementById('bid-total-display');
  if (td) {
    td.textContent = totalBids;
    td.className   = `info-value ${totalBids === cards ? 'text-negative' : 'text-positive'}`;
  }
  document.getElementById('bid-round-number').textContent = state.currentRound + 1;
  document.getElementById('bid-cards-count').textContent  = cards;

  // Dealer beperking
  const dealerBid   = round.playerData[dealerName].bid;
  const othersDone  = state.selectedPlayers.every((p, i) =>
    i === dealerIndex || round.playerData[p.name].bid !== null
  );
  const warning = document.getElementById('dealer-restriction-warning');

  if (othersDone && dealerBid === null) {
    const forbidden = calculateForbiddenBid(cards, nonDealerBids);
    if (forbidden !== null) {
      document.getElementById('forbidden-bid-value').textContent = forbidden;
      warning.style.display = 'flex';
      applyDealerRestriction(dealerName, dealerIndex, forbidden);
    } else {
      warning.style.display = 'none';
      clearDealerRestriction(dealerIndex);
    }
  } else {
    warning.style.display = 'none';
    if (dealerBid !== null) clearDealerRestriction(dealerIndex);
  }

  const confirmBtn = document.getElementById('btn-confirm-bids');
  if (confirmBtn) confirmBtn.disabled = !allDone;
}

function applyDealerRestriction(dealerName, dealerIndex, forbiddenBid) {
  const container = document.getElementById('bidding-players-container');
  const card      = container?.querySelector(`[data-player-index="${dealerIndex}"]`);
  if (!card) return;
  card.querySelectorAll('.num-btn').forEach(btn => {
    btn.classList.remove('forbidden');
    btn.disabled = false;
  });
  const fbtn = card.querySelector(`.num-btn[data-value="${forbiddenBid}"]`);
  if (fbtn) { fbtn.classList.add('forbidden'); fbtn.disabled = true; fbtn.title = `Verboden bod (${forbiddenBid})`; }
}

function clearDealerRestriction(dealerIndex) {
  const container = document.getElementById('bidding-players-container');
  container?.querySelector(`[data-player-index="${dealerIndex}"]`)
    ?.querySelectorAll('.num-btn')
    .forEach(b => { b.classList.remove('forbidden'); b.disabled = false; });
}

/* ════════════════════════════════════════════════════════════════
   VIEW: RESULTATEN
   ════════════════════════════════════════════════════════════════ */

function startResultsPhase() {
  state.phase = 'results';
  document.getElementById('bidding-players-container')
    .removeEventListener('click', onBidButtonClick);
  showView('view-results');
  renderResultsView();
}

function renderResultsView() {
  const round     = state.rounds[state.currentRound];
  const cards     = CARDS_PER_ROUND[state.currentRound];
  const container = document.getElementById('results-players-container');
  container.innerHTML = '';
  state.selectedPlayers.forEach(p => {
    if (round.playerData[p.name].tricks === null) round.playerData[p.name].tricks = 0;
  });
  state.selectedPlayers.forEach((player, i) => {
    const bid    = round.playerData[player.name].bid;
    const tricks = round.playerData[player.name].tricks;
    const card   = document.createElement('div');
    card.className          = 'result-player-card';
    card.dataset.playerName = player.name;
    card.innerHTML = `
      <div class="result-player-header">
        <div class="player-avatar">${getInitials(player.name)}</div>
        <span class="result-player-name">${player.name}</span>
        <span class="bid-label">Geboden: <span class="bid-value">${bid}</span></span>
      </div>
      <div class="tricks-input-row">
        <button class="tricks-counter-btn" data-action="dec" data-player="${player.name}" ${tricks <= 0 ? 'disabled' : ''}>−</button>
        <div class="tricks-value-display" id="tricks-display-${i}">${tricks}</div>
        <button class="tricks-counter-btn" data-action="inc" data-player="${player.name}" ${tricks >= cards ? 'disabled' : ''}>+</button>
      </div>
      <div class="score-preview" id="score-preview-${i}">${getScorePreviewHTML(bid, tricks)}</div>
    `;
    container.appendChild(card);
  });
  container.addEventListener('click', onTricksButtonClick);
  updateResultsTotal();
}

function getScorePreviewHTML(bid, tricks) {
  if (bid === null || tricks === null) return '';
  const s    = calculateRoundScore(bid, tricks);
  const cls  = s >= 0 ? 'positive' : 'negative';
  const sign = s > 0 ? '+' : '';
  return `Score: <span class="${cls}">${sign}${s} pts</span>`;
}

function onTricksButtonClick(e) {
  const btn        = e.target.closest('[data-action]');
  if (!btn) return;
  const action     = btn.dataset.action;
  const playerName = btn.dataset.player;
  const round      = state.rounds[state.currentRound];
  const cards      = CARDS_PER_ROUND[state.currentRound];
  let   tricks     = round.playerData[playerName].tricks;
  if (action === 'dec' && tricks > 0) tricks--;
  else if (action === 'inc' && tricks < cards) tricks++;
  else return;
  round.playerData[playerName].tricks = tricks;
  const idx = state.selectedPlayers.findIndex(p => p.name === playerName);
  const bid = round.playerData[playerName].bid;
  document.getElementById(`tricks-display-${idx}`).textContent = tricks;
  document.getElementById(`score-preview-${idx}`).innerHTML    = getScorePreviewHTML(bid, tricks);
  const pc = btn.closest('.result-player-card');
  pc.querySelector('[data-action="dec"]').disabled = tricks <= 0;
  pc.querySelector('[data-action="inc"]').disabled = tricks >= cards;
  updateResultsTotal();
}

function updateResultsTotal() {
  const round  = state.rounds[state.currentRound];
  const cards  = CARDS_PER_ROUND[state.currentRound];
  const sum    = state.selectedPlayers.reduce((s, p) => s + (round.playerData[p.name].tricks ?? 0), 0);
  document.getElementById('res-total-display').textContent = `${sum} / ${cards}`;
  document.getElementById('res-round-number').textContent  = state.currentRound + 1;
  document.getElementById('res-cards-count').textContent   = cards;
  const msg     = document.getElementById('results-validation-msg');
  const saveBtn = document.getElementById('btn-save-round');
  if (sum === cards) {
    msg.style.display = 'none';
    saveBtn.disabled  = false;
  } else {
    const diff = cards - sum;
    msg.className    = 'alert alert-warning';
    msg.innerHTML    = `<span class="alert-icon">⚠</span>Totaal (${sum}) ≠ kaarten (${cards}). ${diff > 0 ? `Nog ${diff} te verdelen.` : `${Math.abs(diff)} te veel.`}`;
    msg.style.display = 'flex';
    saveBtn.disabled  = true;
  }
}

/* ════════════════════════════════════════════════════════════════
   RONDE OPSLAAN
   ════════════════════════════════════════════════════════════════ */

async function saveRound() {
  const round = state.rounds[state.currentRound];
  state.selectedPlayers.forEach(p => {
    const d = round.playerData[p.name];
    d.score = calculateRoundScore(d.bid, d.tricks);
  });
  document.getElementById('results-players-container')
    .removeEventListener('click', onTricksButtonClick);
  try { await saveGameRounds(state.gameId, state.rounds); }
  catch (err) { showToast(`Opslaan mislukt: ${err.message}`, 'error'); }
  state.phase = 'scoreboard';
  renderScoreboard();
}

/* ════════════════════════════════════════════════════════════════
   VIEW: SCOREBORD
   ════════════════════════════════════════════════════════════════ */

function renderScoreboard() {
  state.phase = 'scoreboard';
  updateProgressBar();
  updateHomeButton();
  showView('view-scoreboard');

  const names       = state.selectedPlayers.map(p => p.name);
  const isLastRound = state.currentRound === TOTAL_ROUNDS - 1;
  document.getElementById('scoreboard-title').textContent =
    isLastRound ? '🏆 Eindscores' : `Scorebord na ronde ${state.currentRound + 1}`;
  document.getElementById('btn-next-round').style.display  = isLastRound ? 'none'        : 'inline-flex';
  document.getElementById('btn-finish-game').style.display = isLastRound ? 'inline-flex' : 'none';

  const thead = document.getElementById('scoreboard-thead');
  const tbody = document.getElementById('scoreboard-tbody');
  const tfoot = document.getElementById('scoreboard-tfoot');

  let hdr = '<tr><th>Ronde</th>';
  names.forEach(n => {
    hdr += `<th colspan="4" style="border-left:2px solid var(--border)">
      <div class="player-avatar" style="margin:0 auto;width:28px;height:28px;font-size:.75rem;">${getInitials(n)}</div>
      <div style="font-size:.8rem;margin-top:2px;">${n}</div>
    </th>`;
  });
  hdr += '</tr><tr><th></th>';
  names.forEach(() => {
    hdr += '<th style="border-left:2px solid var(--border);">Bod</th><th>Slagen</th><th>Score</th><th>∑</th>';
  });
  thead.innerHTML = hdr + '</tr>';

  const cumulative = {};
  names.forEach(n => cumulative[n] = 0);
  let bodyHTML = '';
  for (let ri = 0; ri <= state.currentRound; ri++) {
    const round = state.rounds[ri];
    if (!round) continue;
    const cards = CARDS_PER_ROUND[ri];
    bodyHTML += `<tr class="${ri === state.currentRound ? 'current-round' : ''}">`;
    bodyHTML += `<td><strong>${ri + 1}</strong><br><span style="font-size:.72rem;color:var(--text-muted)">${cards}♦</span></td>`;
    names.forEach(name => {
      const d      = round.playerData?.[name];
      const score  = d?.score ?? null;
      if (score !== null) cumulative[name] += score;
      const cumCls = cumulative[name] >= 0 ? 'text-gold' : 'text-negative';
      bodyHTML += `
        <td style="border-left:2px solid var(--border)" class="cell-bid editable"
            data-round="${ri}" data-player="${name}" data-field="bid">${d?.bid ?? '—'}</td>
        <td class="editable" data-round="${ri}" data-player="${name}" data-field="tricks">${d?.tricks ?? '—'}</td>
        <td>${score !== null ? formatScore(score) : '—'}</td>
        <td><span class="cell-cumulative ${cumCls}">${cumulative[name]}</span></td>
      `;
    });
    bodyHTML += '</tr>';
  }
  tbody.innerHTML = bodyHTML;

  const totals = calculateCumulativeScores(names, state.rounds);
  let foot = '<tr><td>Totaal</td>';
  names.forEach(n => {
    const t   = totals[n];
    const cls = t >= 0 ? 'text-gold' : 'text-negative';
    foot += `<td colspan="4" style="border-left:2px solid var(--border)"><span class="${cls}">${t}</span></td>`;
  });
  tfoot.innerHTML = foot + '</tr>';
  applyEditMode();
}

function applyEditMode() {
  const table = document.getElementById('scoreboard-table');
  table?.classList.toggle('edit-mode', state.isEditMode);
}

function toggleEditMode() {
  state.isEditMode = !state.isEditMode;
  document.getElementById('edit-mode-banner').style.display = state.isEditMode ? 'flex' : 'none';
  document.getElementById('btn-toggle-edit').textContent    = state.isEditMode ? '✓ Klaar' : '✏ Bewerken';
  applyEditMode();
}

function handleScoreboardCellClick(e) {
  if (!state.isEditMode) return;
  const cell = e.target.closest('.editable');
  if (!cell) return;
  const ri         = parseInt(cell.dataset.round, 10);
  const playerName = cell.dataset.player;
  const field      = cell.dataset.field;
  const round      = state.rounds[ri];
  const cards      = CARDS_PER_ROUND[ri];
  const cur        = round.playerData[playerName][field] ?? 0;

  let dealerWarning = null;
  if (field === 'bid') {
    const { dealerIndex } = getBiddingOrder(ri);
    if (state.selectedPlayers[dealerIndex].name === playerName) {
      const otherBids = state.selectedPlayers
        .filter(p => p.name !== playerName)
        .map(p => round.playerData[p.name].bid ?? 0);
      const f = calculateForbiddenBid(cards, otherBids);
      if (f !== null) dealerWarning = `Let op: ${f} is het verboden bod (dealer-beperking).`;
    }
  }

  openEditModal({
    title:       `Corrigeer ${field === 'bid' ? 'bod' : 'slagen'} — ${playerName}`,
    description: `Ronde ${ri + 1} (${cards} kaarten). Huidige waarde: ${cur}`,
    currentValue: cur, min: 0, max: cards, warning: dealerWarning,
    onSave: async newValue => {
      round.playerData[playerName][field] = newValue;
      if (field === 'tricks') {
        const sumT = state.selectedPlayers.reduce((s, p) => s + (round.playerData[p.name].tricks ?? 0), 0);
        if (sumT !== cards) showToast(`Som slagen (${sumT}) ≠ kaarten (${cards}). Pas ook anderen aan.`, 'error', 5000);
      }
      recalculateFromRound(ri);
      try {
        await saveGameRounds(state.gameId, state.rounds);
        showToast('Correctie opgeslagen', 'success');
      } catch (err) { showToast(`Opslaan mislukt: ${err.message}`, 'error'); }
      renderScoreboard();
    }
  });
}

/* ════════════════════════════════════════════════════════════════
   EDIT MODAL
   ════════════════════════════════════════════════════════════════ */

function openEditModal({ title, description, currentValue, min, max, warning, onSave }) {
  const modal  = document.getElementById('edit-modal');
  const input  = document.getElementById('edit-value-input');
  const warnEl = document.getElementById('edit-modal-warning');
  document.getElementById('edit-modal-title').textContent = title;
  document.getElementById('edit-modal-desc').textContent  = description;
  input.value = currentValue; input.min = min; input.max = max;
  warnEl.textContent     = warning ?? '';
  warnEl.style.display   = warning ? 'block' : 'none';
  modal.style.display    = 'flex';

  // Vervang knoppen om oude listeners te wissen
  ['edit-dec', 'edit-inc'].forEach(id => {
    const old = document.getElementById(id);
    const neu = old.cloneNode(true);
    old.parentNode.replaceChild(neu, old);
  });

  const update = () => {
    const v = parseInt(input.value, 10);
    document.getElementById('edit-dec').disabled = v <= min;
    document.getElementById('edit-inc').disabled = v >= max;
  };
  update();
  document.getElementById('edit-dec').addEventListener('click', () => {
    const v = parseInt(input.value, 10); if (v > min) { input.value = v - 1; update(); }
  });
  document.getElementById('edit-inc').addEventListener('click', () => {
    const v = parseInt(input.value, 10); if (v < max) { input.value = v + 1; update(); }
  });
  input.addEventListener('input', update);

  document.getElementById('edit-modal-cancel').onclick = () => modal.style.display = 'none';
  document.getElementById('edit-modal-save').onclick   = async () => {
    const v = parseInt(input.value, 10);
    if (isNaN(v) || v < min || v > max) { showToast(`Waarde tussen ${min}–${max}`, 'error'); return; }
    modal.style.display = 'none';
    await onSave(v);
  };
  modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
}

/* ════════════════════════════════════════════════════════════════
   VOLGENDE RONDE / AFSLUITEN
   ════════════════════════════════════════════════════════════════ */

function goToNextRound() {
  state.currentRound++;
  state.isEditMode = false;
  document.getElementById('edit-mode-banner').style.display = 'none';
  startBiddingPhase();
}

async function finishGame() {
  try {
    setLoading(true);
    const names   = state.selectedPlayers.map(p => p.name);
    const totals  = calculateCumulativeScores(names, state.rounds);
    const ranking = calculateFinalRanking(totals);
    await finalizeGame(state.gameId, state.rounds, ranking);
    showToast('Spel opgeslagen! 🏆', 'success');
    renderStatsView(ranking);
  } catch (err) { showToast(`Afsluiten mislukt: ${err.message}`, 'error'); }
  finally { setLoading(false); }
}

/* ════════════════════════════════════════════════════════════════
   VIEW: STATISTIEKEN
   ════════════════════════════════════════════════════════════════ */

async function renderStatsView(finalRanking = null) {
  state.phase = 'stats';
  updateProgressBar();
  updateHomeButton();
  showView('view-stats');

  // Eindstand sectie
  const finalSection = document.getElementById('final-results-section');
  if (finalRanking) {
    finalSection.style.display = 'block';
    renderPodium(finalRanking);
    renderFinalScoresList(finalRanking);
  } else {
    finalSection.style.display = 'none';
  }

  // Records laden
  document.getElementById('global-records-container').innerHTML =
    '<div class="loading-records">Records laden…</div>';

  try {
    const records = await calculateGlobalRecords();
    renderGlobalRecords(records);
    setupStatsPlayerSearch(records);
  } catch (err) {
    document.getElementById('global-records-container').innerHTML =
      `<p class="text-muted">Records konden niet geladen worden: ${err.message}</p>`;
  }
}

/* ── Podium ── */
function renderPodium(ranking) {
  const podium  = document.getElementById('final-podium');
  podium.innerHTML = '';
  const top3    = ranking.slice(0, 3);
  const order   = top3.length >= 3 ? [top3[1], top3[0], top3[2]] : top3;
  const medals  = ['🥈', '🥇', '🥉'];
  const heights = [80, 110, 60];
  order.forEach((player, i) => {
    const actualIdx = top3.length >= 3 ? [1, 0, 2][i] : i;
    const item = document.createElement('div');
    item.className = 'podium-item';
    item.innerHTML = `
      <div class="podium-avatar">${getInitials(player.playerName)}</div>
      <div class="podium-name">${player.playerName}</div>
      <div class="podium-score">${player.totalScore} pts</div>
      <div class="podium-block" style="height:${heights[actualIdx] || 60}px">${medals[actualIdx] || player.rank}</div>
    `;
    podium.appendChild(item);
  });
}

function renderFinalScoresList(ranking) {
  const list = document.getElementById('final-scores-list');
  list.innerHTML = '';
  ranking.forEach(p => {
    const row = document.createElement('div');
    row.className = 'final-score-row';
    row.innerHTML = `
      <span class="final-rank">#${p.rank}</span>
      <div class="player-avatar">${getInitials(p.playerName)}</div>
      <span class="final-player-name">${p.playerName}</span>
      <span class="final-player-score">${p.totalScore} pts</span>
    `;
    list.appendChild(row);
  });
}

/* ── Globale Records ── */
function renderGlobalRecords(records) {
  const container = document.getElementById('global-records-container');
  container.innerHTML = '';

  const defs = [
    {
      label: '🏆 Hoogste eindscore',
      data:  records.highestFinalScore,
      render: r => `<span class="record-value">${r.value} pts</span>
        <span class="record-meta">${r.playerName} · ${fmtDate(r.date)}</span>
        ${r.witnesses.length ? `<span class="record-meta">Getuigen: ${r.witnesses.join(', ')}</span>` : ''}`
    },
    {
      label: '💀 Laagste eindscore',
      data:  records.lowestFinalScore,
      render: r => `<span class="record-value">${r.value} pts</span>
        <span class="record-meta">${r.playerName} · ${fmtDate(r.date)}</span>`
    },
    {
      label: '⚡ Hoogste ronde-score',
      data:  records.highestRoundScore,
      render: r => `<span class="record-value">${r.value > 0 ? '+' : ''}${r.value} pts</span>
        <span class="record-meta">${r.playerName} · Ronde ${r.round} · ${fmtDate(r.date)}</span>`
    },
    {
      label: '🔥 Laagste ronde-score',
      data:  records.lowestRoundScore,
      render: r => `<span class="record-value">${r.value} pts</span>
        <span class="record-meta">${r.playerName} · Ronde ${r.round} · ${fmtDate(r.date)}</span>`
    },
    {
      label: '🎯 Langste perfecte reeks',
      data:  records.longestPerfectStreak,
      render: r => `<span class="record-value">${r.length} rondes op rij exact</span>
        <span class="record-meta">${r.playerName} · ${fmtDate(r.date)}</span>`
    },
    {
      label: '🎰 Grootste puntenverschil',
      data:  records.biggestMargin,
      render: r => `<span class="record-value">${r.margin} punten verschil</span>
        <span class="record-meta">${r.winner} vs. ${r.loser} · ${fmtDate(r.date)}</span>`
    }
  ];

  for (const def of defs) {
    const item = document.createElement('div');
    item.className = 'record-item';
    item.innerHTML = `
      <span class="record-label">${def.label}</span>
      ${def.data
        ? `<div class="record-content">${def.render(def.data)}</div>`
        : '<span class="text-muted" style="font-size:.85rem">Nog geen data</span>'}
    `;
    container.appendChild(item);
  }
}

/* ── Speler zoeken voor stats ── */
function setupStatsPlayerSearch(records) {
  const input     = document.getElementById('stats-player-search');
  const dropdown  = document.getElementById('stats-autocomplete');
  const dashboard = document.getElementById('player-stats-dashboard');

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    dropdown.innerHTML = '';
    if (!q) { dropdown.classList.remove('open'); return; }
    const matches = state.allPlayers.filter(p => p.name.toLowerCase().includes(q));
    matches.slice(0, 8).forEach(pl => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.textContent = pl.name;
      item.addEventListener('click', () => {
        input.value = pl.name;
        dropdown.classList.remove('open');
        renderPlayerDashboard(pl.name, records, dashboard);
      });
      dropdown.appendChild(item);
    });
    dropdown.classList.toggle('open', dropdown.children.length > 0);
  });
  document.addEventListener('click', e => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) dropdown.classList.remove('open');
  });
}

/* ════════════════════════════════════════════════════════════════
   SPELER DASHBOARD — Volledig uitgewerkt
   ════════════════════════════════════════════════════════════════ */

function renderPlayerDashboard(playerName, records, container) {
  const stats = records.playerStats?.[playerName];
  container.style.display = 'block';

  if (!stats) {
    container.innerHTML = `<p class="text-muted">Geen voltooide spellen voor ${playerName}.</p>`;
    return;
  }

  const first = playerName.split(' ')[0];

  // Betrouwbaarheids-badge
  const confBadge = renderConfidenceBadge(stats);

  // Fun facts
  const facts      = generateFunFacts(playerName, stats);
  const factsHTML  = facts.length
    ? `<div class="fun-facts-block">${facts.map(f => `<div class="fun-fact">${f}</div>`).join('')}</div>`
    : '';

  // Streak display
  const streakHTML = renderStreakBadge(stats.currentStreak);

  // Trend pijl
  const trendHTML  = renderTrendBadge(stats.recentTrend);

  // Key metrics
  const avgRankStr  = stats.avgRank   !== null ? `#${stats.avgRank.toFixed(1)}`   : '—';
  const avgScoreStr = stats.avgScore  !== null ? Math.round(stats.avgScore)        : '—';

  container.innerHTML = `
    <div class="dashboard-header">
      <div class="dashboard-avatar">${getInitials(playerName)}</div>
      <div class="dashboard-meta">
        <h4 class="dashboard-name">${playerName}</h4>
        <div class="dashboard-badges">
          ${confBadge}
          ${streakHTML}
          ${trendHTML}
        </div>
      </div>
    </div>

    ${factsHTML}

    <div class="stats-section-title">📊 Overzicht</div>
    <div class="stats-grid">
      ${statCard(stats.totalGames,                   'Potjes')}
      ${statCard(stats.totalRounds,                  'Rondes')}
      ${statCard(stats.winCount,                     'Gewonnen')}
      ${statCard(`${stats.top3Count}x`,              'Top 3')}
      ${statCard(`${stats.correctPct.toFixed(0)}%`,  'Raak %')}
      ${statCard(avgRankStr,                         'Gem. plek')}
      ${statCard(avgScoreStr,                        'Gem. score')}
      ${statCard(stats.bestScore  ?? '—',            'Beste score', 'positive')}
      ${statCard(stats.worstScore ?? '—',            'Slechtste',   'negative')}
      ${statCard(stats.longestPerfectStreak,         'Beste reeks')}
    </div>

    ${stats.bidBehavior ? renderBidBehaviorSection(stats.bidBehavior) : ''}

    ${stats.scoreHistory.length >= 2 ? `
      <div class="stats-section-title">📈 Scoreverloop</div>
      <div class="chart-outer">${renderMiniChart(stats.scoreHistory)}</div>
    ` : ''}

    <div class="stats-section-title">🃏 Gespeelde potjes (${stats.totalGames})</div>
    <div class="games-list" id="games-list-${playerName.replace(/\s/g, '_')}">
      ${stats.games.map((g, i) => renderGameCard(g, playerName, i)).join('')}
    </div>
  `;

  // Event listeners voor uitklapbare potjes
  container.querySelectorAll('.game-card-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const card    = btn.closest('.game-history-card');
      const details = card.querySelector('.game-card-details');
      const isOpen  = details.classList.contains('open');
      details.classList.toggle('open', !isOpen);
      btn.textContent = isOpen ? '▼ Toon details' : '▲ Verberg';
    });
  });
}

function statCard(value, label, colorClass = '') {
  return `
    <div class="stat-card">
      <div class="stat-value ${colorClass ? 'text-' + colorClass : ''}">${value}</div>
      <div class="stat-label">${label}</div>
    </div>
  `;
}

/* ── Confidence badge ── */
function renderConfidenceBadge(stats) {
  const map = {
    low:    { cls: 'conf-low',    icon: '⚠',  text: `${stats.totalGames} potje${stats.totalGames > 1 ? 's' : ''}` },
    medium: { cls: 'conf-medium', icon: '◎',  text: `${stats.totalGames} potjes` },
    high:   { cls: 'conf-high',   icon: '✓',  text: `${stats.totalGames} potjes` }
  };
  const { cls, icon, text } = map[stats.dataConfidence] ?? map.low;
  return `<span class="confidence-badge ${cls}" title="Gebaseerd op ${stats.totalGames} volledige potjes">${icon} ${text}</span>`;
}

/* ── Streak badge ── */
function renderStreakBadge(streak) {
  if (!streak || streak.count < 2) return '';
  const labels = { win: '🔥 Win streak', top3: '⭐ Top 3 streak', loss: '😅 Verliesreeks' };
  const cls    = { win: 'streak-win', top3: 'streak-top3', loss: 'streak-loss' };
  return `<span class="streak-badge ${cls[streak.type] ?? ''}">${labels[streak.type] ?? ''} × ${streak.count}</span>`;
}

/* ── Trend badge ── */
function renderTrendBadge(trend) {
  if (!trend || trend.direction === 'stable') return '';
  const labels = { up: `📈 +${trend.delta} trend`, down: `📉 ${trend.delta} trend` };
  const cls    = { up: 'trend-up', down: 'trend-down' };
  return `<span class="trend-badge ${cls[trend.direction]}">${labels[trend.direction]}</span>`;
}

/* ── Bied-gedrag sectie ── */
function renderBidBehaviorSection(bh) {
  const tendencyLabels = {
    over:     '📈 Overschatter',
    under:    '📉 Onderschatter',
    balanced: '⚖ Gebalanceerd'
  };
  const zeroPctStr = bh.zeroBids.pct !== null
    ? `${bh.zeroBids.success}/${bh.zeroBids.count} (${bh.zeroBids.pct.toFixed(0)}%)`
    : `${bh.zeroBids.count} keer (geen data)`;

  // Per-ronde-type tabel
  const roundTypeRows = Object.entries(bh.bidsByRoundType)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([cards, d]) => {
      const pct = d.correctPct;
      const cls = pct >= 70 ? 'text-positive' : pct < 40 ? 'text-negative' : '';
      const barW = Math.round(pct);
      return `
        <div class="round-type-row">
          <span class="rt-label">${cards}♦</span>
          <div class="rt-bar-wrap">
            <div class="rt-bar" style="width:${barW}%"></div>
          </div>
          <span class="rt-pct ${cls}">${pct.toFixed(0)}%</span>
          <span class="rt-count text-muted">(${d.total}×)</span>
        </div>
      `;
    }).join('');

  return `
    <div class="stats-section-title">🎯 Bied-gedrag</div>
    <div class="bid-behavior-panel">
      <div class="bb-row">
        <span class="bb-label">Neiging</span>
        <span class="bb-value">${tendencyLabels[bh.tendencyDirection] ?? '—'}
          ${Math.abs(bh.avgMissDir) > 0.1 ? `<small class="text-muted">(gem. ${bh.avgMissDir > 0 ? '+' : ''}${bh.avgMissDir.toFixed(1)} bij missen)</small>` : ''}
        </span>
      </div>
      ${bh.zeroBids.count > 0 ? `
      <div class="bb-row">
        <span class="bb-label">Nul-biedingen</span>
        <span class="bb-value">${zeroPctStr}</span>
      </div>` : ''}
      ${bh.bestRoundType ? `
      <div class="bb-row">
        <span class="bb-label">Sterkst in</span>
        <span class="bb-value text-positive">${bh.bestRoundType.cards} kaarten (${bh.bestRoundType.correctPct.toFixed(0)}%)</span>
      </div>` : ''}
      ${bh.worstRoundType && bh.worstRoundType.cards !== bh.bestRoundType?.cards ? `
      <div class="bb-row">
        <span class="bb-label">Zwakst in</span>
        <span class="bb-value text-negative">${bh.worstRoundType.cards} kaarten (${bh.worstRoundType.correctPct.toFixed(0)}%)</span>
      </div>` : ''}
    </div>
    <div class="round-type-grid">
      <div class="rt-header">
        <span>Type</span><span>Goed %</span><span></span><span>Gespeeld</span>
      </div>
      ${roundTypeRows}
    </div>
  `;
}

/* ── Mini score-grafiek (inline SVG) ── */
function renderMiniChart(scoreHistory) {
  if (scoreHistory.length < 2) return '';

  const W = 320, H = 100, PAD = 16;
  const scores = scoreHistory.map(s => s.score);
  const minS   = Math.min(...scores);
  const maxS   = Math.max(...scores);
  const range  = maxS - minS || 1;

  const toX = i  => PAD + (i / (scores.length - 1)) * (W - PAD * 2);
  const toY = s  => PAD + (1 - (s - minS) / range) * (H - PAD * 2);

  // Lijn-path
  const points = scores.map((s, i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(s).toFixed(1)}`).join(' ');

  // Opvulling
  const fillPath = `${points} L${toX(scores.length - 1).toFixed(1)},${H - PAD} L${toX(0).toFixed(1)},${H - PAD} Z`;

  // Punten (dots)
  const dots = scores.map((s, i) => {
    const x    = toX(i).toFixed(1);
    const y    = toY(s).toFixed(1);
    const cls  = s === maxS ? 'chart-dot-max' : s === minS ? 'chart-dot-min' : 'chart-dot';
    const tip  = `#${scoreHistory[i].rank} | ${s} pts | ${fmtDate(scoreHistory[i].date)}`;
    return `<circle class="${cls}" cx="${x}" cy="${y}" r="${s === maxS || s === minS ? 5 : 3}" data-tip="${tip}"/>`;
  }).join('');

  // Labels linksboven/rechtsonder
  const lastScore  = scores[scores.length - 1];
  const lastX      = toX(scores.length - 1);
  const lastY      = toY(lastScore);

  return `
    <svg class="mini-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Scoreverloop">
      <defs>
        <linearGradient id="chartGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="var(--gold)" stop-opacity="0.3"/>
          <stop offset="100%" stop-color="var(--gold)" stop-opacity="0"/>
        </linearGradient>
      </defs>
      <!-- Nul-lijn -->
      ${minS < 0 && maxS > 0 ? `<line class="chart-zero-line"
        x1="${PAD}" y1="${toY(0).toFixed(1)}"
        x2="${W - PAD}" y2="${toY(0).toFixed(1)}"/>` : ''}
      <!-- Opvulling -->
      <path class="chart-fill" d="${fillPath}"/>
      <!-- Lijn -->
      <path class="chart-line" d="${points}"/>
      <!-- Punten -->
      ${dots}
      <!-- Labels uitersten -->
      <text class="chart-label-max" x="${toX(scores.indexOf(maxS)).toFixed(1)}" y="${(toY(maxS) - 8).toFixed(1)}">${maxS}</text>
      <text class="chart-label-min" x="${toX(scores.indexOf(minS)).toFixed(1)}" y="${(toY(minS) + 14).toFixed(1)}">${minS}</text>
    </svg>
  `;
}

/* ── Per-potje kaart ── */
function renderGameCard(game, playerName, index) {
  const dateStr  = fmtDate(game.date);
  const rankStr  = `#${game.rank}`;
  const rankCls  = game.rank === 1 ? 'text-gold' : game.rank <= 3 ? 'text-positive' : '';
  const scoreCls = game.totalScore >= 0 ? 'text-positive' : 'text-negative';
  const pct      = game.correctPctInGame.toFixed(0);

  // Meest recente potje: uitvouwen badge
  const isLatest = index === 0;

  // Scorekaart per ronde (compacte tabel)
  const roundRows = game.rounds.map(r => {
    const exact  = r.bid !== null && r.bid === r.tricks;
    const sCls   = r.score !== null ? (r.score > 0 ? 'pos' : r.score < 0 ? 'neg' : '') : '';
    const sign   = r.score > 0 ? '+' : '';
    return `
      <tr class="${exact ? 'exact-row' : ''}">
        <td>${r.roundIndex + 1}</td>
        <td>${r.cards}♦</td>
        <td>${r.bid ?? '—'}</td>
        <td>${r.tricks ?? '—'}</td>
        <td><span class="cell-score ${sCls}">${r.score !== null ? sign + r.score : '—'}</span></td>
        <td>${exact ? '🎯' : ''}</td>
      </tr>
    `;
  }).join('');

  // Highlights (MVP, beste/slechtste ronde)
  const highlights = [];
  if (game.mvpCount >= 10) highlights.push(`🎯 ${game.mvpCount}/15 rondes exact geraden`);
  if (game.bestRound) highlights.push(`⭐ Beste ronde: ronde ${game.bestRound.roundIndex + 1} (+${game.bestRound.score || 0} pts)`);
  if (game.worstRound && game.worstRound.score < 0) highlights.push(`💥 Slechtste ronde: ronde ${game.worstRound.roundIndex + 1} (${game.worstRound.score} pts)`);
  if (game.comebackRound) highlights.push(`📈 Comeback in ronde ${game.comebackRound.fromRound + 1}`);

  const highlightHTML = highlights.length
    ? `<div class="game-highlights">${highlights.map(h => `<span class="game-highlight">${h}</span>`).join('')}</div>`
    : '';

  return `
    <div class="game-history-card${isLatest ? ' latest' : ''}">
      <div class="game-card-header">
        <div class="game-card-date">${isLatest ? '🆕 ' : ''}${dateStr}</div>
        <div class="game-card-meta">
          <span class="game-rank ${rankCls}">${rankStr}</span>
          <span class="game-score ${scoreCls}">${game.totalScore > 0 ? '+' : ''}${game.totalScore} pts</span>
          <span class="game-pct">${pct}% raak</span>
          <span class="game-players text-muted">${game.participants.join(', ')}</span>
        </div>
        <button class="game-card-toggle btn btn-ghost btn-sm">▼ Toon details</button>
      </div>
      <div class="game-card-details">
        ${highlightHTML}
        <div class="game-rounds-scroll">
          <table class="game-rounds-table">
            <thead>
              <tr>
                <th>#</th><th>Kaarten</th><th>Bod</th><th>Slagen</th><th>Score</th><th></th>
              </tr>
            </thead>
            <tbody>${roundRows}</tbody>
          </table>
        </div>
      </div>
    </div>
  `;
}

/* ════════════════════════════════════════════════════════════════
   EVENT LISTENERS
   ════════════════════════════════════════════════════════════════ */

function registerEventListeners() {
  document.getElementById('btn-dark-mode').addEventListener('click', () => {
    document.body.classList.toggle('dark-mode');
    document.querySelector('.icon-moon').textContent =
      document.body.classList.contains('dark-mode') ? '☀' : '☾';
  });
  document.getElementById('btn-home').addEventListener('click', () => {
    if (confirm('Terug naar de lobby? Het huidige spel gaat verloren.')) renderLobby();
  });
  document.getElementById('btn-start-game').addEventListener('click', startGame);
  document.getElementById('btn-show-stats').addEventListener('click', () => {
    state.phase = 'stats'; renderStatsView();
  });
  document.getElementById('btn-confirm-bids').addEventListener('click', () => {
    const round = state.rounds[state.currentRound];
    const done  = state.selectedPlayers.every(p => round.playerData[p.name].bid !== null);
    if (!done) { showToast('Niet alle spelers hebben geboden', 'error'); return; }
    startResultsPhase();
  });
  document.getElementById('btn-save-round').addEventListener('click', saveRound);
  document.getElementById('btn-toggle-edit').addEventListener('click', toggleEditMode);
  document.getElementById('scoreboard-tbody').addEventListener('click', handleScoreboardCellClick);
  document.getElementById('btn-next-round').addEventListener('click', goToNextRound);
  document.getElementById('btn-finish-game').addEventListener('click', finishGame);
  document.getElementById('btn-new-game')?.addEventListener('click', renderLobby);
  document.getElementById('btn-stats-to-lobby').addEventListener('click', renderLobby);
}

/* ════════════════════════════════════════════════════════════════
   APP INITIALISATIE
   ════════════════════════════════════════════════════════════════ */

export async function initApp() {
  try {
    registerEventListeners();
    state.allPlayers = await getAllPlayers();
    setupPlayerSearch();
    setLoading(false);
    renderLobby();
  } catch (err) {
    console.error('App init mislukt:', err);
    setLoading(false);
    showToast('Verbinding database mislukt. Controleer Firebase config.', 'error', 8000);
    renderLobby();
  }
}
