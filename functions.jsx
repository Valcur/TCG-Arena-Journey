const HERO_SECTIONS = ["Hero1", "Hero2", "Hero3"]
const HERO_INDEXES = [1, 2, 3]

/** Log préfixé pour filtrer facilement la console */
function log(...args) {
    console.log("[Journey]", ...args)
}

/** Position du joueur local dans l'ordre de la table (clé de ses données dans le bloc partagé Order) */
function myPosition() {
    return game.turn.orderPosition ?? 0
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
 * (nom, PV, Agility, Step Back). L'hôte tire aussi le joueur qui a la priorité sur les égalités au premier tour.
 */
async function ini() {
    const adventurers = [...(cards?.Hero1 ?? [])].slice(0, HERO_SECTIONS.length)
    log("ini : position", myPosition(), "/ hôte", game.isHost, "/", adventurers.length, "Adventurer(s) en Hero1")

    if (game.isHost && (game.data.Order.priorityStart === null || game.data.Order.priorityStart === undefined)) {
        game.data.Order.priorityStart = Math.floor(Math.random() * Math.max(1, game.turn.totalPlayers))
        log("ini : joueur tiré pour la priorité de départ", game.data.Order.priorityStart)
    }

    if (adventurers.length === 0) return

    for (let i = 1; i < adventurers.length; i++) {
        log("ini : déplacement vers", HERO_SECTIONS[i])
        await functions.moveCard(adventurers[i], HERO_SECTIONS[i])
    }

    game.data.Stats.position = myPosition()
    adventurers.forEach((card, i) => {
        const data = functions.getCardData(card)
        const n = i + 1
        game.data.Stats["name" + n] = shortName(data?.name)
        game.data.Stats["hp" + n] = toNumber(data?.hp)
        game.data.Stats["agi" + n] = toNumber(data?.agility)
        game.data.Stats["step" + n] = false
        log(`ini : Adventurer ${n} = ${game.data.Stats["name" + n]}, PV ${game.data.Stats["hp" + n]}, Agility ${game.data.Stats["agi" + n]}`)
    })

    await functions.repositionCards()
}

// ─────────────────────────────── Actions du joueur (bloc Stats) ───────────────────────────────

/** PV de l'Adventurer n° index (1 à 3) */
function setHp(index, value) {
    game.data.Stats["hp" + index] = toNumber(value)
    log(`setHp : Adventurer ${index} → ${game.data.Stats["hp" + index]} PV`)
}

/** Agility totale de l'Adventurer n° index (1 à 3) */
function setAgi(index, value) {
    game.data.Stats["agi" + index] = toNumber(value)
    log(`setAgi : Adventurer ${index} → Agility ${game.data.Stats["agi" + index]}`)
}

/** Step Back de l'Adventurer n° index (1 à 3) : une seule fois par tour */
function stepBack(index) {
    if (game.data.Stats["step" + index]) {
        log(`stepBack : Adventurer ${index} a déjà fait son Step Back ce tour`)
        return
    }
    game.data.Stats["step" + index] = true
    log(`stepBack : Adventurer ${index} (${game.data.Stats["name" + index]})`)
}

/** Nouveau tour : chaque joueur récupère ses Step Back ; l'hôte passe la priorité au joueur suivant */
function newTurn() {
    log("newTurn : tour", game.turn.count, "/ mon tour", game.turn.isMyTurn)
    for (const n of HERO_INDEXES) {
        if (game.data.Stats["step" + n]) {
            game.data.Stats["step" + n] = false
            log(`newTurn : Step Back de l'Adventurer ${n} remis à disposition`)
        }
    }
    if (game.isHost) rebuildOrder()
}

// ─────────────────────────────── Hôte : bloc partagé Order ───────────────────────────────

/** onUpdate du bloc Stats : l'hôte reporte ses propres stats dans Order */
function onMyStatsUpdate() {
    if (!game.isHost) return
    log("onMyStatsUpdate : stats de l'hôte modifiées")
    storeStats({ ...game.data.Stats, position: myPosition() })
}

/** onOpponentUpdate du bloc Stats : l'hôte reporte les stats de l'adversaire dans Order */
function onOpponentStats(data) {
    if (!game.isHost) return
    const stats = data?.Stats ?? data
    if (stats?.position === null || stats?.position === undefined) {
        log("onOpponentStats : données reçues sans position, ignorées", data)
        return
    }
    log("onOpponentStats : stats du joueur en position", stats.position)
    storeStats(stats)
}

/** Enregistre les Adventurers d'un joueur (nom, Agility, Step Back) dans Order et recalcule l'ordre */
function storeStats(stats) {
    const entry = {
        position: stats.position,
        heroes: HERO_INDEXES.map(n => ({
            name: stats["name" + n] ?? "",
            agi: toNumber(stats["agi" + n]),
            step: !!stats["step" + n],
        })).filter(h => h.name),
    }
    game.data.Order.players = { ...(game.data.Order.players ?? {}), [entry.position]: entry }
    log("storeStats : position", entry.position, entry.heroes)
    rebuildOrder()
}

/**
 * Liste affichée dans la barre : tous les Adventurers de tous les joueurs, hors Step Back d'abord, puis par Agility
 * décroissante. sep = séparateur affiché avant l'élément ("›" Agility différente, "=" égalité, "" pour le premier).
 * Priorité sur les égalités : joueur tiré au premier tour, puis le joueur suivant à chaque nouveau tour.
 */
function rebuildOrder() {
    const players = Object.values(game.data.Order.players ?? {})
        .filter(p => p && p.position !== null && p.position !== undefined)
        .sort((a, b) => a.position - b.position)

    const heroes = []
    for (const p of players) {
        p.heroes.forEach((h, slot) => heroes.push({ ...h, position: p.position, slot }))
    }
    heroes.sort((a, b) => (a.step - b.step) || (b.agi - a.agi) || (a.position - b.position) || (a.slot - b.slot))

    game.data.Order.list = heroes.map((h, i) => {
        const prev = heroes[i - 1]
        const tie = prev && !prev.step && !h.step && prev.agi === h.agi
        return { name: h.name, position: h.position, step: h.step, sep: i === 0 ? "" : tie ? "=" : "›" }
    })

    const total = Math.max(1, game.turn.totalPlayers)
    if (game.data.Order.priorityStart !== null && game.data.Order.priorityStart !== undefined) {
        game.data.Order.priority = (toNumber(game.data.Order.priorityStart) + toNumber(game.turn.count)) % total
    }

    log("rebuildOrder :", game.data.Order.list.map(h => h.sep + h.name).join(" "), "| priorité : position", game.data.Order.priority)
}
