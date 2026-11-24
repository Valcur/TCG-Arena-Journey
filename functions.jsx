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

/**
 * Répartit les 3 Adventurers posés en Hero1 sur Hero1, Hero2 et Hero3 et remplit le bloc Stats du joueur
 * (identifiant, nom, PV, Agility, Step Back, action faite). L'hôte tire aussi le joueur qui a la priorité au premier tour.
 */
async function ini() {
    const adventurers = [...(cards?.Hero1 ?? [])].slice(0, HERO_SECTIONS.length)
    log("ini: position", myPosition(), "/ host", game.isHost, "/", adventurers.length, "Adventurer(s) in Hero1")

    if (game.isHost && !isSet(game.data.Order.priorityStart)) {
        game.data.Order.priorityStart = Math.floor(Math.random() * Math.max(1, game.turn.totalPlayers))
        log("ini: random starting priority player", game.data.Order.priorityStart)
    }

    if (adventurers.length === 0) return

    for (let i = 1; i < adventurers.length; i++) {
        log("ini: moving to", HERO_SECTIONS[i])
        await functions.moveCard(adventurers[i], HERO_SECTIONS[i])
    }

    game.data.Stats.playerId = adventurers[0].owner ?? null
    adventurers.forEach((card, i) => {
        const data = functions.getCardData(card)
        const n = i + 1
        game.data.Stats["name" + n] = shortName(data?.name)
        game.data.Stats["hp" + n] = toNumber(data?.hp)
        game.data.Stats["agi" + n] = toNumber(data?.agility)
        game.data.Stats["step" + n] = false
        game.data.Stats["done" + n] = false
        log(`ini: Adventurer ${n} = ${game.data.Stats["name" + n]}, HP ${game.data.Stats["hp" + n]}, Agility ${game.data.Stats["agi" + n]}`)
    })
    syncIdentity()

    await functions.repositionCards()
}

/**
 * Recopie dans Stats la position et le pseudo du joueur dès qu'ils sont connus ou qu'ils changent : ils arrivent
 * parfois après onPlayersReady, et Stats est le seul bloc que les autres joueurs reçoivent.
 */
function syncIdentity() {
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

/** PV de l'Adventurer n° index (1 à 3) */
function setHp(index, value) {
    game.data.Stats["hp" + index] = toNumber(value)
    log(`setHp: Adventurer ${index} -> ${game.data.Stats["hp" + index]} HP`)
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

/** Pass : marque comme ayant agi tous les Adventurers du joueur dont c'est actuellement le tour */
function pass() {
    syncIdentity()
    const active = game.data.Order.active ?? []
    const passed = []
    HERO_INDEXES.forEach((n, slot) => {
        if (active.includes(heroKey(game.data.Stats.position, slot)) && !game.data.Stats["done" + n]) {
            game.data.Stats["done" + n] = true
            passed.push(game.data.Stats["name" + n])
        }
    })
    log("pass:", passed.length ? passed.join(", ") : "no Adventurer of mine was active", "/ active:", active)
}

/** Nouveau tour : chaque joueur récupère ses Step Back et ses actions, et la priorité passe au joueur suivant */
function newTurn() {
    log("newTurn: turn", game.turn.count, "/ my turn", game.turn.isMyTurn)
    syncIdentity()
    for (const n of HERO_INDEXES) {
        if (game.data.Stats["step" + n]) game.data.Stats["step" + n] = false
        if (game.data.Stats["done" + n]) game.data.Stats["done" + n] = false
    }
    rebuildOrder()
}

// ─────────────────────────────── Bloc partagé Order ───────────────────────────────
// Tous les joueurs recalculent Order : chez l'hôte la mise à jour est diffusée à tous, chez les autres elle reste
// locale (affichage immédiat) jusqu'à ce que la version de l'hôte arrive.

/** onUpdate du bloc Stats : reporte ses propres stats dans Order */
function onMyStatsUpdate() {
    log("onMyStatsUpdate: my stats changed / host", game.isHost)
    storeStats(game.data.Stats)
}

/** onOpponentUpdate du bloc Stats : reporte les stats de l'adversaire dans Order */
function onOpponentStats(opponentData) {
    const stats = opponentData?.Stats
    log("onOpponentStats: player", stats?.playerId, "/ position", stats?.position, "/ pseudo", stats?.pseudo || opponentData?.pseudo)
    storeStats(stats, opponentData?.pseudo)
}

/**
 * Enregistre les Adventurers d'un joueur dans Order, indexés par son identifiant (et non par sa position, qui peut
 * n'être connue qu'après coup), puis recalcule l'ordre. Ignoré tant que la position du joueur est inconnue.
 */
function storeStats(stats, pseudoFallback) {
    if (!stats || !isSet(stats.position)) {
        log("storeStats: position unknown yet, ignored", stats)
        return
    }
    const key = stats.playerId ?? `position-${stats.position}`
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
 * - priority / priorityPseudo : joueur tiré au premier tour, puis le joueur suivant à chaque nouveau tour.
 */
function rebuildOrder() {
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