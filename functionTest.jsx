const HERO_SECTIONS = ["Hero1", "Hero2", "Hero3"]
const HERO_INDEXES = [1, 2, 3]

/** Log préfixé pour filtrer facilement la console */
function log(...args) {
    console.log("[Journey]", ...args)
}

function isSet(value) {
    return value !== null && value !== undefined
}

/** Position du joueur local dans l'ordre de la table, ou null tant que le moteur ne l'a pas fournie */
function myPosition() {
    return isSet(game.turn?.orderPosition) ? game.turn.orderPosition : null
}

/** Clé d'un Adventurer dans Order.active : "position-emplacement" (emplacement 0 à 2) */
function heroKey(position, slot) {
    return `${position}-${slot}`
}

/** "Hyla, Bog Lurker" → "Hyla" */
function shortName(name) {
    return String(name ?? "").split(",")[0].trim()
}

function toNumber(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : 0
}

// ─────────────────────────────── Initialisation ───────────────────────────────

/** Section où le moteur pose les Adventurers en début de partie (categoriesAlreadyOnBoard) */
const START_SECTION = "Hero2"

/**
 * Répartit les 3 Adventurers posés en Hero2 : le 1er va en Hero1, le 2e reste en Hero2, le 3e va en Hero3.
 * Remplit ensuite le bloc Stats du joueur (identifiant, nom, PV, Agility, Step Back, action faite), puis reporte
 * ces stats dans Order sans attendre onUpdate.
 */
async function ini() {
    const adventurers = [...(cards?.[START_SECTION] ?? [])].slice(0, HERO_SECTIONS.length)
    log("ini: position", myPosition(), "/ host", game.isHost, "/", adventurers.length, "Adventurer(s) in", START_SECTION)

    if (adventurers.length === 0) {
        syncIdentity()
        rebuildOrder()
        return
    }

    for (let i = 0; i < adventurers.length; i++) {
        if (HERO_SECTIONS[i] === START_SECTION) continue
        log("ini: moving to", HERO_SECTIONS[i])
        await functions.moveCard(adventurers[i], HERO_SECTIONS[i])
    }

    adventurers.forEach((card, i) => {
        const data = functions.getCardData(card)
        const n = i + 1
        game.data.Stats["name" + n] = shortName(data?.name)
        game.data.Stats["hp" + n] = toNumber(data?.hp)
        game.data.Stats["agi" + n] = toNumber(data?.agility)
        game.data.Stats["baseAgi" + n] = toNumber(data?.agility)
        game.data.Stats["step" + n] = false
        game.data.Stats["done" + n] = false
        log(`ini: Adventurer ${n} = ${game.data.Stats["name" + n]}, HP ${game.data.Stats["hp" + n]}, Agility ${game.data.Stats["agi" + n]}`)
    })
    syncIdentity()
    storeStats(game.data.Stats, game.pseudo, game.playerId)

    await functions.repositionCards()
}

/**
 * Recopie dans Stats l'identifiant, la position et le pseudo du joueur dès qu'ils sont connus ou qu'ils changent :
 * ils arrivent parfois après onPlayersReady, et Stats est le seul bloc que les autres joueurs reçoivent.
 */
function syncIdentity() {
    const playerId = game.playerId
    if (isSet(playerId) && game.data.Stats.playerId !== playerId) {
        log("syncIdentity: playerId", game.data.Stats.playerId, "->", playerId)
        game.data.Stats.playerId = playerId
    }
    const position = myPosition()
    if (isSet(position) && game.data.Stats.position !== position) {
        log("syncIdentity: position", game.data.Stats.position, "->", position)
        game.data.Stats.position = position
    }
    const pseudo = game.pseudo
    if (pseudo && game.data.Stats.pseudo !== pseudo) {
        log("syncIdentity: pseudo", game.data.Stats.pseudo, "->", pseudo)
        game.data.Stats.pseudo = pseudo
    }
}

// ─────────────────────────────── Actions du joueur (bloc Stats) ───────────────────────────────

/** Carte Adventurer de la zone Hero n° index (1 à 3) : les Equipment peuvent être groupés dans la même zone */
function heroCard(index) {
    const sectionCards = cards?.[HERO_SECTIONS[index - 1]] ?? []
    return sectionCards.find(card => functions.getCardData(card)?.type === "Adventurer") ?? sectionCards[0] ?? null
}

/**
 * PV de l'Adventurer n° index (1 à 3).
 * À 0 PV ou moins, la carte est retournée face cachée (Knocked Out) ; si elle remonte au-dessus de 0, elle est
 * retournée face visible. Stats.koN mémorise l'état pour n'agir qu'au changement.
 */
async function setHp(index, value) {
    const previous = toNumber(game.data.Stats["hp" + index])
    const hp = toNumber(value)
    game.data.Stats["hp" + index] = hp
    log(`setHp: Adventurer ${index} -> ${hp} HP`)

    const diff = hp - previous
    if (diff !== 0) {
        const name = game.data.Stats["name" + index] || `Adventurer ${index}`
        functions.chatLog(`${name} ${diff > 0 ? "+" : ""}${diff} HP (${previous} → ${hp})`)
    }

    const knockedOut = hp <= 0
    if (!!game.data.Stats["ko" + index] === knockedOut) return

    const card = heroCard(index)
    if (!card) {
        log(`setHp: no card in ${HERO_SECTIONS[index - 1]}`)
        return
    }
    await functions.hideCards([card], knockedOut ? "yes" : "no")
    game.data.Stats["ko" + index] = knockedOut
    log(`setHp: Adventurer ${index} (${game.data.Stats["name" + index]}) ${knockedOut ? "Knocked Out, face down" : "back face up"}`)
}

/** Agility totale de l'Adventurer n° index (1 à 3) */
function setAgi(index, value) {
    game.data.Stats["agi" + index] = toNumber(value)
    log(`setAgi: Adventurer ${index} -> Agility ${game.data.Stats["agi" + index]}`)
}

/** Step Back de l'Adventurer n° index (1 à 3) : une seule fois par tour */
function stepBack(index) {
    if (game.data.Stats["step" + index]) {
        log(`stepBack: Adventurer ${index} already stepped back this turn`)
        return
    }
    game.data.Stats["step" + index] = true
    log(`stepBack: Adventurer ${index} (${game.data.Stats["name" + index]})`)
}

/** Remet l'Agility des 3 Adventurers du joueur à la valeur imprimée sur leur carte */
function resetAgility() {
    HERO_INDEXES.forEach((n, i) => {
        const adventurer = heroCard(n)
        if (!adventurer) {
            log(`resetAgility: no card in ${HERO_SECTIONS[i]}`)
            return
        }
        const agility = toNumber(functions.getCardData(adventurer)?.agility)
        game.data.Stats["agi" + n] = agility
        game.data.Stats["baseAgi" + n] = agility
        log(`resetAgility: Adventurer ${n} (${game.data.Stats["name" + n]}) -> Agility ${agility}`)
    })
    storeStats(game.data.Stats, game.pseudo, game.playerId)
}

/**
 * Pass : marque comme ayant agi tous les Adventurers du joueur dont c'est actuellement le tour,
 * et les Exhaust (carte inclinée, cardRotation du gamefile).
 */
async function pass() {
    syncIdentity()
    const active = game.data.Order.active ?? []
    const passed = []
    const toExhaust = []
    HERO_INDEXES.forEach((n, slot) => {
        if (active.includes(heroKey(game.data.Stats.position, slot)) && !game.data.Stats["done" + n]) {
            game.data.Stats["done" + n] = true
            passed.push(game.data.Stats["name" + n])
            const card = heroCard(n)
            if (card && !card.isTapped) toExhaust.push(card)
        }
    })
    log("pass:", passed.length ? passed.join(", ") : "no Adventurer of mine was active", "/ active:", active)

    if (toExhaust.length) await functions.updateCards(toExhaust, { isTapped: true })
}

/**
 * Nouveau tour : chaque joueur récupère ses Step Back et ses actions, ses Adventurers Exhaust sont redressés,
 * et la priorité passe au joueur suivant.
 * Les entrées de tous les joueurs dans Order sont remises à zéro tout de suite, sans attendre leur onOpponentUpdate,
 * et les stats du joueur local y sont reportées directement, sans dépendre de onUpdate.
 */
async function newTurn() {
    log("newTurn: turn", game.turn.count, "/ my turn", game.turn.isMyTurn)
    syncIdentity()
    for (const n of HERO_INDEXES) {
        if (game.data.Stats["step" + n]) game.data.Stats["step" + n] = false
        if (game.data.Stats["done" + n]) game.data.Stats["done" + n] = false
    }

    const exhausted = HERO_INDEXES.map(heroCard).filter(card => card?.isTapped)
    if (exhausted.length) {
        log("newTurn: readying", exhausted.length, "Adventurer(s)")
        await functions.updateCards(exhausted, { isTapped: false })
    }

    const players = {}
    for (const [k, p] of Object.entries(game.data.Order.players ?? {})) {
        if (!p) continue
        players[k] = { ...p, heroes: (p.heroes ?? []).map(h => ({ ...h, step: false, done: false })) }
    }
    game.data.Order.players = players

    storeStats(game.data.Stats, game.pseudo, game.playerId)
}

// ─────────────────────────────── Cycle (défausse face cachée) ───────────────────────────────

/**
 * onCardsEnter de la section Discard : les cartes défaussées partent dans ExileHidden, le Cycle face cachée.
 * transitionCards contient les cartes qui viennent d'entrer dans Discard.
 */
async function cycleCards(transitionCards) {
    const entered = transitionCards ?? []
    if (entered.length === 0) return
    log("cycleCards:", entered.length, "card(s) from Discard to ExileHidden")
    await functions.moveCards(entered, "ExileHidden", { noLogs: true })
    await functions.repositionCards()
}

// ─────────────────────────────── Bloc partagé Order ───────────────────────────────
// Tous les joueurs recalculent Order à partir des blocs Stats reçus : chez l'hôte la mise à jour est diffusée à tous,
// chez les autres elle reste locale. Le joueur prioritaire tiré par l'hôte transite par son bloc Stats
// (Stats.priorityStart), que tous les joueurs reçoivent, pour ne pas dépendre de la diffusion d'Order.

/** onUpdate du bloc Stats : reporte ses propres stats dans Order */
function onMyStatsUpdate() {
    log("onMyStatsUpdate: my stats changed / host", game.isHost)
    syncIdentity()
    storeStats(game.data.Stats, game.pseudo, game.playerId)
}

/**
 * onOpponentUpdate du bloc Stats : reporte les stats de l'adversaire dans Order.
 * - À la première réception d'un joueur, ajoute son identifiant à Stats.knownPlayers : cette modification renvoie
 *   nos propres stats à tous (ce joueur a pu les manquer). Elle n'a lieu qu'une fois par joueur, sans boucle.
 * - Reprend le joueur prioritaire tiré par l'hôte s'il est présent dans ses stats.
 */
function onOpponentStats(opponentGame) {
    const stats = opponentGame?.data?.Stats
    const playerId = stats?.playerId ?? opponentGame?.playerId
    log("onOpponentStats: player", playerId, "/ position", stats?.position, "/ pseudo", stats?.pseudo || opponentGame?.pseudo)

    syncIdentity()

    const known = game.data.Stats.knownPlayers ?? []
    if (isSet(playerId) && !known.includes(playerId)) {
        game.data.Stats.knownPlayers = [...known, playerId]
        log("onOpponentStats: new player", playerId, "-> my stats are sent again")
    }

    if (isSet(stats?.priorityStart) && game.data.Order.priorityStart !== stats.priorityStart) {
        game.data.Order.priorityStart = stats.priorityStart
        log("onOpponentStats: starting priority player from host", stats.priorityStart)
    }

    storeStats(stats, opponentGame?.pseudo, opponentGame?.playerId)
}

/**
 * Enregistre les Adventurers d'un joueur dans Order, indexés par son identifiant (et non par sa position, qui peut
 * n'être connue qu'après coup), puis recalcule l'ordre. Ignoré tant que la position du joueur est inconnue.
 */
function storeStats(stats, pseudoFallback, playerIdFallback) {
    if (!stats || !isSet(stats.position)) {
        log("storeStats: position unknown yet, ignored", stats)
        return
    }
    const key = stats.playerId ?? playerIdFallback ?? `position-${stats.position}`
    const previous = game.data.Order.players?.[key]
    const entry = {
        playerId: key,
        position: stats.position,
        pseudo: stats.pseudo || pseudoFallback || previous?.pseudo || "",
        heroes: HERO_INDEXES.map(n => ({
            name: stats["name" + n] ?? "",
            agi: toNumber(stats["agi" + n]),
            step: !!stats["step" + n],
            done: !!stats["done" + n],
        })),
    }

    const players = {}
    for (const [k, p] of Object.entries(game.data.Order.players ?? {})) {
        if (k !== key && p?.position !== entry.position) players[k] = p
    }
    players[key] = entry
    game.data.Order.players = players

    log("storeStats: player", key, "/ position", entry.position, "/ pseudo", entry.pseudo, entry.heroes)
    rebuildOrder()
}

/**
 * Recalcule l'affichage de la barre et les Adventurers dont c'est le tour.
 * - list : tous les Adventurers de tous les joueurs, hors Step Back d'abord, puis par Agility décroissante.
 *   sep = séparateur affiché avant l'élément ("›" Agility différente, "=" égalité, "" pour le premier).
 * - active : clés "position-emplacement" des Adventurers qui n'ont pas encore agi et qui partagent la meilleure
 *   place restante (même groupe Step Back, même Agility). Le groupe suivant devient actif quand tous ont passé.
 * - priority / priorityPseudo : joueur tiré au hasard par l'hôte la première fois qu'il recalcule l'ordre,
 *   puis le joueur suivant à chaque nouveau tour.
 */
function rebuildOrder() {
    if (game.isHost && !isSet(game.data.Stats.priorityStart)) {
        game.data.Stats.priorityStart = Math.floor(Math.random() * Math.max(1, toNumber(game.turn.totalPlayers)))
        log("rebuildOrder: random starting priority player", game.data.Stats.priorityStart)
    }
    if (isSet(game.data.Stats.priorityStart) && game.data.Order.priorityStart !== game.data.Stats.priorityStart) {
        game.data.Order.priorityStart = game.data.Stats.priorityStart
    }

    const players = Object.values(game.data.Order.players ?? {})
        .filter(p => p && isSet(p.position))
        .sort((a, b) => a.position - b.position)

    const heroes = []
    for (const p of players) {
        p.heroes.forEach((h, slot) => {
            if (h.name) heroes.push({ ...h, position: p.position, slot })
        })
    }
    heroes.sort((a, b) => (a.step - b.step) || (b.agi - a.agi) || (a.position - b.position) || (a.slot - b.slot))

    game.data.Order.list = heroes.map((h, i) => {
        const prev = heroes[i - 1]
        const tie = prev && prev.step === h.step && prev.agi === h.agi
        return { name: h.name, position: h.position, slot: h.slot, step: h.step, done: h.done, sep: i === 0 ? "" : tie ? "=" : "›" }
    })

    const remaining = heroes.filter(h => !h.done)
    const first = remaining[0]
    game.data.Order.active = first
        ? remaining.filter(h => h.step === first.step && h.agi === first.agi).map(h => heroKey(h.position, h.slot))
        : []

    const total = Math.max(1, game.turn.totalPlayers)
    if (isSet(game.data.Order.priorityStart)) {
        game.data.Order.priority = (toNumber(game.data.Order.priorityStart) + toNumber(game.turn.count)) % total
        game.data.Order.priorityPseudo = players.find(p => p.position === game.data.Order.priority)?.pseudo ?? ""
    }

    log("rebuildOrder:", game.data.Order.list.map(h => h.sep + h.name + (h.step ? "(SB)" : "") + (h.done ? "(done)" : "")).join(" "),
        "| active:", game.data.Order.active, "| priority:", game.data.Order.priority, game.data.Order.priorityPseudo)
}
