/**
 * database-service.js
 * ════════════════════════════════════════════════════════════════
 * Alle asynchrone Firestore-logica + statistieken-engine.
 *
 * COLLECTIES:
 *   players → { name, createdAt }
 *   games   → { date, participants, rounds, finalScores, completed }
 *
 * STATISTIEKEN FILOSOFIE:
 *   - Geen harde minimumdrempel — altijd tonen met betrouwbaarheidsindicator.
 *   - dataConfidence: 'low' (1–2) | 'medium' (3–4) | 'high' (5+)
 *   - Alle berekeningen client-side vanuit de games-collectie.
 * ════════════════════════════════════════════════════════════════
 */

import { db } from './firebase-config.js';
import {
  collection, doc, addDoc, updateDoc,
  getDocs, query, where, orderBy,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';

const COL_PLAYERS = 'players';
const COL_GAMES   = 'games';

/** Kaarten per ronde — ook lokaal nodig voor bid-analyse. */
const CARDS_PER_ROUND = [1, 2, 3, 4, 5, 6, 7, 7, 7, 6, 5, 4, 3, 2, 1];

/* ════════════════════════════════════════════════════════════════
   SPELER FUNCTIES
   ════════════════════════════════════════════════════════════════ */

export async function getAllPlayers() {
  const q        = query(collection(db, COL_PLAYERS), orderBy('name', 'asc'));
  const snapshot = await getDocs(q);
  return snapshot.docs.map(d => ({
    id:        d.id,
    name:      d.data().name,
    createdAt: d.data().createdAt?.toDate() ?? new Date()
  }));
}

export async function addPlayer(name) {
  const trimmed = name.trim();
  if (!trimmed)           throw new Error('Naam mag niet leeg zijn');
  if (trimmed.length > 50) throw new Error('Naam te lang (max. 50 tekens)');
  const ref = await addDoc(collection(db, COL_PLAYERS), {
    name: trimmed, createdAt: serverTimestamp()
  });
  return { id: ref.id, name: trimmed };
}

/* ════════════════════════════════════════════════════════════════
   SPEL FUNCTIES
   ════════════════════════════════════════════════════════════════ */

export async function createGame(participantNames) {
  const ref = await addDoc(collection(db, COL_GAMES), {
    date: serverTimestamp(), participants: participantNames,
    rounds: [], finalScores: [], completed: false
  });
  return ref.id;
}

export async function saveGameRounds(gameId, roundsData) {
  await updateDoc(doc(db, COL_GAMES, gameId), { rounds: roundsData });
}

export async function finalizeGame(gameId, roundsData, finalScores) {
  await updateDoc(doc(db, COL_GAMES, gameId), {
    rounds: roundsData, finalScores,
    completed: true, completedAt: serverTimestamp()
  });
}

export async function getCompletedGames() {
  const q = query(
    collection(db, COL_GAMES),
    where('completed', '==', true),
    orderBy('date', 'asc')          // asc: chronologisch voor streak-berekening
  );
  const snapshot = await getDocs(q);
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
}

/* ════════════════════════════════════════════════════════════════
   STATISTIEKEN ENGINE
   ════════════════════════════════════════════════════════════════ */

/**
 * Centrale statistieken-berekening. Verwerkt alle voltooide spellen en
 * retourneert globale records + uitgebreide per-speler profielen.
 *
 * @returns {Promise<{
 *   highestFinalScore, lowestFinalScore,
 *   highestRoundScore, lowestRoundScore,
 *   longestPerfectStreak, biggestMargin,
 *   playerStats: { [name]: PlayerStats }
 * }>}
 */
export async function calculateGlobalRecords() {
  const games = await getCompletedGames();

  // Globale record-houders
  let highestFinal        = null;
  let lowestFinal         = null;
  let highestRound        = null;
  let lowestRound         = null;
  let globalBestStreak    = null;   // { playerName, length, date }
  let biggestMargin       = null;   // { winner, loser, margin, date, participants }

  // Per-speler ruwe data verzamelen
  const playerRaw = new Map(); // name → { gameResults[], allRounds[] }

  function getRaw(name) {
    if (!playerRaw.has(name)) {
      playerRaw.set(name, { gameResults: [], allRounds: [] });
    }
    return playerRaw.get(name);
  }

  // ── Itereer over alle spellen ────────────────────────────────
  for (const game of games) {
    const participants = game.participants || [];
    const rounds       = game.rounds       || [];
    const finalScores  = game.finalScores  || [];
    const gameDate     = game.date?.toDate?.() ?? new Date();

    // Grootste puntenverschil in dit spel
    if (finalScores.length >= 2) {
      const sorted = [...finalScores].sort((a, b) => b.totalScore - a.totalScore);
      const margin = sorted[0].totalScore - sorted[sorted.length - 1].totalScore;
      if (!biggestMargin || margin > biggestMargin.margin) {
        biggestMargin = {
          winner: sorted[0].playerName,
          loser:  sorted[sorted.length - 1].playerName,
          margin, date: gameDate,
          participants: participants.slice()
        };
      }
    }

    // Per speler verwerken
    for (const name of participants) {
      const raw        = getRaw(name);
      const finalEntry = finalScores.find(f => f.playerName === name);
      if (!finalEntry) continue;

      // Ronde-data voor dit spel
      const gameRounds = [];
      rounds.forEach((round, ri) => {
        const d = round.playerData?.[name];
        if (!d) return;
        const entry = {
          roundIndex: ri,
          cards:      CARDS_PER_ROUND[ri] ?? round.cards,
          bid:        d.bid    ?? null,
          tricks:     d.tricks ?? null,
          score:      d.score  ?? null,
          gameId:     game.id,
          date:       gameDate
        };
        gameRounds.push(entry);
        raw.allRounds.push(entry);

        // Ronde-records
        if (d.score !== null) {
          const w = participants.filter(p => p !== name);
          if (!highestRound || d.score > highestRound.value)
            highestRound = { value: d.score, playerName: name, round: ri + 1, date: gameDate, witnesses: w };
          if (!lowestRound  || d.score < lowestRound.value)
            lowestRound  = { value: d.score, playerName: name, round: ri + 1, date: gameDate, witnesses: w };
        }
      });

      // Eindstand-records
      const score = finalEntry.totalScore;
      const w     = participants.filter(p => p !== name);
      if (!highestFinal || score > highestFinal.value)
        highestFinal = { value: score, playerName: name, date: gameDate, witnesses: w };
      if (!lowestFinal  || score < lowestFinal.value)
        lowestFinal  = { value: score, playerName: name, date: gameDate, witnesses: w };

      raw.gameResults.push({
        gameId: game.id, date: gameDate,
        participants: participants.slice(),
        playerCount:  participants.length,
        totalScore:   score,
        rank:         finalEntry.rank,
        rounds:       gameRounds
      });
    }
  }

  // ── Bereken per-speler statistieken ────────────────────────
  const playerStats = {};

  for (const [name, raw] of playerRaw.entries()) {
    const gR = raw.gameResults;           // oud → nieuw
    const aR = raw.allRounds;

    const totalGames  = gR.length;
    const totalRounds = aR.length;
    const correctBids = aR.filter(r => r.bid !== null && r.bid === r.tricks).length;
    const correctPct  = totalRounds > 0 ? (correctBids / totalRounds) * 100 : 0;

    const dataConfidence =
      totalGames >= 5 ? 'high' : totalGames >= 3 ? 'medium' : 'low';

    const ranks     = gR.map(g => g.rank);
    const avgRank   = ranks.length > 0 ? ranks.reduce((a, b) => a + b, 0) / ranks.length : null;
    const winCount  = ranks.filter(r => r === 1).length;
    const top3Count = ranks.filter(r => r <= 3).length;

    const scores     = gR.map(g => g.totalScore);
    const avgScore   = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const bestScore  = scores.length > 0 ? Math.max(...scores) : null;
    const worstScore = scores.length > 0 ? Math.min(...scores) : null;

    const scoreHistory = gR.map((g, i) => ({
      index: i + 1, date: g.date, score: g.totalScore,
      rank: g.rank, gameId: g.gameId
    }));

    const currentStreak       = _calcCurrentStreak(gR);
    const longestPerfectStreak = _calcLongestPerfectStreak(aR);
    const recentTrend          = _calcRecentTrend(scores);
    const bidBehavior          = _analyzeBidBehavior(aR);

    // Bijhouden van de globale beste streak
    if (!globalBestStreak || longestPerfectStreak > globalBestStreak.length) {
      globalBestStreak = {
        length: longestPerfectStreak, playerName: name,
        date:   gR[gR.length - 1]?.date ?? new Date()
      };
    }

    // Per-potje display-data (meest recent eerst)
    const gamesForDisplay = [...gR].reverse().map(g => ({
      ...g,
      correctBidsInGame: g.rounds.filter(r => r.bid !== null && r.bid === r.tricks).length,
      correctPctInGame:  g.rounds.length > 0
        ? g.rounds.filter(r => r.bid !== null && r.bid === r.tricks).length / g.rounds.length * 100
        : 0,
      mvpCount:    _countExactBids(g.rounds),
      bestRound:   _findExtremRound(g.rounds, 'best'),
      worstRound:  _findExtremRound(g.rounds, 'worst'),
      comebackRound: _findComebackMoment(g.rounds)
    }));

    playerStats[name] = {
      totalGames, totalRounds, correctBids, correctPct,
      dataConfidence, avgRank, winCount, top3Count,
      avgScore, bestScore, worstScore,
      scoreHistory, currentStreak, longestPerfectStreak,
      recentTrend, bidBehavior,
      games: gamesForDisplay
    };
  }

  return {
    highestFinalScore:    highestFinal,
    lowestFinalScore:     lowestFinal,
    highestRoundScore:    highestRound,
    lowestRoundScore:     lowestRound,
    longestPerfectStreak: globalBestStreak,
    biggestMargin,
    playerStats
  };
}

/* ════════════════════════════════════════════════════════════════
   HULPFUNCTIES (INTERN)
   ════════════════════════════════════════════════════════════════ */

function _calcCurrentStreak(gameResults) {
  if (!gameResults.length) return null;
  const rev = [...gameResults].reverse();
  const classify = g => g.rank === 1 ? 'win' : g.rank <= 3 ? 'top3' : 'loss';
  const type = classify(rev[0]);
  let count = 0;
  for (const g of rev) {
    if (classify(g) === type) count++;
    else break;
  }
  return { type, count };
}

function _calcLongestPerfectStreak(allRounds) {
  let max = 0, cur = 0;
  for (const r of allRounds) {
    if (r.bid !== null && r.tricks !== null) {
      if (r.bid === r.tricks) { cur++; if (cur > max) max = cur; }
      else cur = 0;
    }
  }
  return max;
}

function _analyzeBidBehavior(allRounds) {
  const valid = allRounds.filter(r => r.bid !== null && r.tricks !== null && r.cards > 0);
  if (!valid.length) return null;

  const avgBidRatio = valid.reduce((s, r) => s + r.bid / r.cards, 0) / valid.length;

  const missed = valid.filter(r => r.bid !== r.tricks);
  const avgMissDir = missed.length > 0
    ? missed.reduce((s, r) => s + (r.bid - r.tricks), 0) / missed.length
    : 0;
  const tendencyDirection =
    avgMissDir >  0.4 ? 'over' :
    avgMissDir < -0.4 ? 'under' : 'balanced';

  const zeroBids = valid.filter(r => r.bid === 0);
  const zeroHit  = zeroBids.filter(r => r.tricks === 0).length;

  // Per kaarten-type
  const byCards = {};
  for (const r of valid) {
    if (!byCards[r.cards]) byCards[r.cards] = { bids: [], correct: 0, total: 0 };
    byCards[r.cards].bids.push(r.bid);
    byCards[r.cards].total++;
    if (r.bid === r.tricks) byCards[r.cards].correct++;
  }
  const bidsByRoundType = {};
  for (const [c, d] of Object.entries(byCards)) {
    bidsByRoundType[c] = {
      avgBid:     d.bids.reduce((a, b) => a + b, 0) / d.bids.length,
      correctPct: (d.correct / d.total) * 100,
      total:      d.total
    };
  }

  // Best / slechtst presterende ronde-type (min. 2 samples)
  const qualified = Object.entries(bidsByRoundType)
    .filter(([, d]) => d.total >= 2)
    .sort((a, b) => b[1].correctPct - a[1].correctPct);
  const bestRoundType  = qualified.length ? { cards: Number(qualified[0][0]),     ...qualified[0][1] }     : null;
  const worstRoundType = qualified.length ? { cards: Number(qualified[qualified.length - 1][0]), ...qualified[qualified.length - 1][1] } : null;

  return {
    avgBidRatio, tendencyDirection, avgMissDir,
    zeroBids: { count: zeroBids.length, success: zeroHit, pct: zeroBids.length > 0 ? zeroHit / zeroBids.length * 100 : null },
    bidsByRoundType, bestRoundType, worstRoundType
  };
}

function _calcRecentTrend(scores) {
  if (scores.length < 2) return null;
  const overall   = scores.reduce((a, b) => a + b, 0) / scores.length;
  const recent    = scores.slice(-Math.min(3, scores.length));
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const delta     = recentAvg - overall;
  return {
    direction: delta > 3 ? 'up' : delta < -3 ? 'down' : 'stable',
    delta: Math.round(delta)
  };
}

function _countExactBids(rounds) {
  return rounds.filter(r => r.bid !== null && r.bid === r.tricks).length;
}

function _findExtremRound(rounds, type) {
  const valid = rounds.filter(r => r.score !== null);
  if (!valid.length) return null;
  return type === 'best'
    ? valid.reduce((b, r) => r.score > b.score ? r : b)
    : valid.reduce((w, r) => r.score < w.score ? r : w);
}

/**
 * Vind de ronde waarop de speler de meeste "inhaalslag" maakte
 * (hoogste score na een negatieve score in de vorige ronde).
 */
function _findComebackMoment(rounds) {
  for (let i = 1; i < rounds.length; i++) {
    if (rounds[i - 1].score !== null && rounds[i - 1].score < 0 &&
        rounds[i].score     !== null && rounds[i].score     > 0) {
      return { fromRound: i, score: rounds[i].score };
    }
  }
  return null;
}

/* ════════════════════════════════════════════════════════════════
   FUN FACTS GENERATOR  (geëxporteerd voor game-logic.js)
   ════════════════════════════════════════════════════════════════ */

/**
 * Genereer 1–3 dynamische observaties over een speler.
 * Retourneert een array van HTML-strings.
 *
 * @param {string} playerName
 * @param {object} stats - het playerStats object voor deze speler
 * @returns {string[]}
 */
export function generateFunFacts(playerName, stats) {
  const facts = [];
  const first = playerName.split(' ')[0];

  // Goed-percentage oordeel
  if (stats.totalRounds >= 5) {
    if (stats.correctPct >= 70)
      facts.push(`🎯 <strong>${first}</strong> raadt <strong>${stats.correctPct.toFixed(0)}%</strong> van de biedingen exact — een uitstekende bieder!`);
    else if (stats.correctPct < 40)
      facts.push(`🎲 Slechts <strong>${stats.correctPct.toFixed(0)}%</strong> raak — ${first} houdt het spannend voor zichzelf.`);
  }

  // Bied-neiging
  if (stats.bidBehavior) {
    const bh = stats.bidBehavior;
    if (bh.tendencyDirection === 'over' && Math.abs(bh.avgMissDir) >= 0.5)
      facts.push(`📈 Overschatter: bij een gemiste bieding was het bod gemiddeld <strong>${Math.abs(bh.avgMissDir).toFixed(1)} slag te hoog</strong>.`);
    else if (bh.tendencyDirection === 'under' && Math.abs(bh.avgMissDir) >= 0.5)
      facts.push(`📉 Bescheiden bieder: bij missen haalt ${first} gemiddeld <strong>${Math.abs(bh.avgMissDir).toFixed(1)} slagen meer</strong> dan geboden.`);

    if (bh.zeroBids.count >= 3 && bh.zeroBids.pct !== null) {
      if (bh.zeroBids.pct >= 75)
        facts.push(`🛡️ Nul-meester: biedt ${bh.zeroBids.count}× nul en haalt dat <strong>${bh.zeroBids.pct.toFixed(0)}%</strong> van de tijd ook echt.`);
      else if (bh.zeroBids.pct < 40)
        facts.push(`😬 Nul bieden loopt niet altijd goed af: slechts <strong>${bh.zeroBids.pct.toFixed(0)}%</strong> succes.`);
    }

    if (bh.bestRoundType && bh.bestRoundType.correctPct >= 70 && bh.bestRoundType !== bh.worstRoundType)
      facts.push(`⭐ Sterkst in rondes met <strong>${bh.bestRoundType.cards} kaart${bh.bestRoundType.cards > 1 ? 'en' : ''}</strong>: <strong>${bh.bestRoundType.correctPct.toFixed(0)}%</strong> raak.`);
  }

  // Streak
  if (stats.currentStreak?.count >= 2) {
    const { type, count } = stats.currentStreak;
    if (type === 'win')
      facts.push(`🔥 Wint de laatste <strong>${count} potjes op rij</strong>!`);
    else if (type === 'loss' && count >= 3)
      facts.push(`😅 <strong>${count} potjes op rij</strong> niet gewonnen — er komt een ommekeer.`);
  }

  // Perfecte streak
  if (stats.longestPerfectStreak >= 5)
    facts.push(`⚡ Langste perfecte reeks: <strong>${stats.longestPerfectStreak} rondes op rij</strong> exact geraden.`);

  // Recente trend
  if (stats.recentTrend && stats.totalGames >= 4) {
    if (stats.recentTrend.direction === 'up' && stats.recentTrend.delta >= 5)
      facts.push(`📈 In vorm: recentelijk <strong>${stats.recentTrend.delta} punten boven</strong> het eigen gemiddelde.`);
    else if (stats.recentTrend.direction === 'down' && stats.recentTrend.delta <= -5)
      facts.push(`📉 Kleine dip: recentelijk <strong>${Math.abs(stats.recentTrend.delta)} punten onder</strong> het eigen gemiddelde.`);
  }

  return facts.slice(0, 3);
}
