const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3000;
const TICK_RATE_MS = 100;
const RESPAWN_MS = 20_000;
const NPC_SPAWN_INTERVAL = 45_000;
const NPCS_PER_SPAWN = 10;

const MAP_WIDTH = 6000;
const MAP_HEIGHT = 3600;
const BASE_PADDING = 300;

const LANES = {
  top: MAP_HEIGHT * 0.25,
  mid: MAP_HEIGHT * 0.5,
  bot: MAP_HEIGHT * 0.75,
};

const CLASSES = {
  warrior: {
    label: 'Warrior',
    baseHealth: 250,
    armor: 6,
    attackRange: 90,
    attackDamage: 18,
    attackRate: 0.9,
    moveSpeed: 260,
    attackType: 'melee',
    sightRange: 520,
  },
  wizard: {
    label: 'Wizard',
    baseHealth: 140,
    armor: 2,
    attackRange: 320,
    attackDamage: 38,
    attackRate: 1.6,
    moveSpeed: 240,
    attackType: 'magic',
    sightRange: 640,
  },
  cleric: {
    label: 'Cleric',
    baseHealth: 190,
    armor: 5,
    attackRange: 110,
    attackDamage: 14,
    attackRate: 1.1,
    moveSpeed: 255,
    attackType: 'melee',
    sightRange: 500,
  },
  ranger: {
    label: 'Ranger',
    baseHealth: 170,
    armor: 4,
    attackRange: 380,
    attackDamage: 24,
    attackRate: 0.6,
    moveSpeed: 280,
    attackType: 'ranged',
    sightRange: 700,
  },
};

const NPC_STATS = {
  melee: { health: 90, armor: 1, attackDamage: 10, attackRate: 1.2, attackRange: 80, sightRange: 320, moveSpeed: 200 },
  ranged: { health: 70, armor: 0, attackDamage: 7, attackRate: 0.9, attackRange: 220, sightRange: 360, moveSpeed: 195 },
};

const XP_REWARDS = {
  player: 50,
  npc: 5,
  tower: 40,
  crystal: 200,
};

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));

const players = new Map();
const npcs = new Map();
let towers = [];
let crystals = [];
let nextSpawnAt = Date.now() + NPC_SPAWN_INTERVAL;

function basePosition(team) {
  const x = team === 'red' ? BASE_PADDING : MAP_WIDTH - BASE_PADDING;
  return { x, y: MAP_HEIGHT / 2 };
}

function lanePath(team, laneName) {
  const start = team === 'red' ? BASE_PADDING + 40 : MAP_WIDTH - BASE_PADDING - 40;
  const end = team === 'red' ? MAP_WIDTH - BASE_PADDING - 40 : BASE_PADDING + 40;
  const y = LANES[laneName];
  return [
    { x: start, y },
    { x: (start + end) / 2 + (laneName === 'mid' ? 0 : laneName === 'top' ? -120 : 120), y },
    { x: end, y },
  ];
}

function towerPositions() {
  const positions = [];
  Object.keys(LANES).forEach((laneName) => {
    const y = LANES[laneName];
    const segments = [0.25, 0.5, 0.75];
    segments.forEach((portion) => {
      positions.push({ team: 'red', lane: laneName, x: BASE_PADDING + (MAP_WIDTH - BASE_PADDING * 2) * portion, y });
      positions.push({ team: 'blue', lane: laneName, x: MAP_WIDTH - BASE_PADDING - (MAP_WIDTH - BASE_PADDING * 2) * portion, y });
    });
  });
  return positions;
}

function createTowers() {
  const positions = towerPositions();
  return positions.map((pos) => ({
    id: randomUUID(),
    team: pos.team,
    lane: pos.lane,
    x: pos.x,
    y: pos.y,
    health: 350,
    maxHealth: 350,
    armor: 10,
    attackDamage: 60,
    attackRate: 2.4,
    attackRange: 520,
    lastAttackAt: 0,
    type: 'tower',
  }));
}

function createCrystals() {
  return ['red', 'blue'].map((team) => {
    const pos = basePosition(team);
    return {
      id: `${team}-crystal`,
      team,
      x: pos.x,
      y: pos.y,
      health: 1200,
      maxHealth: 1200,
      type: 'crystal',
    };
  });
}

function resetWorld() {
  towers = createTowers();
  crystals = createCrystals();
  npcs.clear();
  nextSpawnAt = Date.now() + NPC_SPAWN_INTERVAL;
  const shuffled = [...players.values()].sort(() => Math.random() - 0.5);
  shuffled.forEach((player, index) => {
    const team = index % 2 === 0 ? 'red' : 'blue';
    assignPlayerTeam(player, team);
    respawnPlayer(player, true);
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket) {
      socket.emit('matchReset', { team, message: 'New match has begun!' });
    }
  });
}

function assignPlayerTeam(player, team) {
  player.team = team;
}

function randomClassChoices() {
  const keys = Object.keys(CLASSES);
  const shuffled = [...keys].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 3);
}

function createPlayer(id, socketId, team, classKey, name = 'Hero') {
  const cls = CLASSES[classKey];
  return {
    id,
    socketId,
    name,
    team,
    classKey,
    x: basePosition(team).x,
    y: basePosition(team).y,
    destination: null,
    health: cls.baseHealth,
    maxHealth: cls.baseHealth,
    armor: cls.armor,
    attackRange: cls.attackRange,
    attackDamage: cls.attackDamage,
    attackRate: cls.attackRate,
    moveSpeed: cls.moveSpeed,
    attackType: cls.attackType,
    sightRange: cls.sightRange,
    xp: 0,
    dead: false,
    respawnAt: null,
    targetId: null,
    targetType: null,
    lastAttackAt: 0,
    type: 'player',
  };
}

function createNPC(team, lane, npcType, index) {
  const stats = NPC_STATS[npcType];
  const path = lanePath(team, lane);
  const start = path[0];
  return {
    id: `npc-${team}-${lane}-${Date.now()}-${index}-${Math.floor(Math.random() * 1000)}`,
    team,
    lane,
    npcType,
    pathIndex: 0,
    path,
    x: start.x,
    y: start.y,
    destination: path[1] ?? path[path.length - 1],
    health: stats.health,
    maxHealth: stats.health,
    armor: stats.armor,
    attackDamage: stats.attackDamage,
    attackRate: stats.attackRate,
    attackRange: stats.attackRange,
    sightRange: stats.sightRange,
    moveSpeed: stats.moveSpeed,
    lastAttackAt: 0,
    targetId: null,
    targetType: null,
    dead: false,
    type: 'npc',
  };
}

function assignTeam() {
  const counts = { red: 0, blue: 0 };
  players.forEach((p) => counts[p.team]++);
  return counts.red <= counts.blue ? 'red' : 'blue';
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function moveTowards(entity, dest, deltaMs) {
  if (!dest) return;
  const dx = dest.x - entity.x;
  const dy = dest.y - entity.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return;
  const maxStep = (entity.moveSpeed * deltaMs) / 1000;
  const ratio = Math.min(1, maxStep / dist);
  entity.x += dx * ratio;
  entity.y += dy * ratio;
}

function handleAttack(attacker, target, now) {
  if (!target || target.dead || target.health <= 0) return;
  const sinceLast = (now - attacker.lastAttackAt) / 1000;
  if (sinceLast < attacker.attackRate) return;
  const dist = distance(attacker, target);
  if (dist > attacker.attackRange) return;
  attacker.lastAttackAt = now;
  const damage = Math.max(1, attacker.attackDamage - target.armor * 0.5);
  target.health -= damage;
  if (target.health <= 0) {
    target.dead = true;
    target.health = 0;
    if (attacker.type === 'player') {
      attacker.xp += XP_REWARDS[target.type] ?? 0;
    }
    if (target.type === 'player') {
      scheduleRespawn(target, now);
    }
  }
}

function scheduleRespawn(player, now) {
  player.dead = true;
  player.respawnAt = now + RESPAWN_MS;
  player.destination = null;
  player.targetId = null;
  player.targetType = null;
}

function respawnPlayer(player, skipTimer = false) {
  const cls = CLASSES[player.classKey];
  player.dead = false;
  player.respawnAt = null;
  player.health = cls.baseHealth;
  player.maxHealth = cls.baseHealth;
  const spawn = basePosition(player.team);
  player.x = spawn.x;
  player.y = spawn.y;
}

function findEntityById(id, type) {
  if (type === 'player') return players.get(id);
  if (type === 'npc') return npcs.get(id);
  if (type === 'tower') return towers.find((t) => t.id === id);
  if (type === 'crystal') return crystals.find((c) => c.id === id);
  return null;
}

function nearestEnemyInSight(entity) {
  const enemies = [];
  players.forEach((p) => {
    if (p.team !== entity.team && !p.dead) enemies.push(p);
  });
  npcs.forEach((n) => {
    if (n.team !== entity.team && !n.dead) enemies.push(n);
  });
  towers.filter((t) => t.team !== entity.team && !t.dead).forEach((t) => enemies.push(t));
  crystals.filter((c) => c.team !== entity.team && !c.dead).forEach((c) => enemies.push(c));
  let closest = null;
  let closestDist = Infinity;
  enemies.forEach((enemy) => {
    const dist = distance(entity, enemy);
    if (dist <= entity.sightRange && dist < closestDist) {
      closestDist = dist;
      closest = enemy;
    }
  });
  return closest;
}

function updateNPCs(deltaMs, now) {
  npcs.forEach((npc) => {
    if (npc.dead) return;
    if (!npc.targetId) {
      const target = nearestEnemyInSight(npc);
      if (target) {
        npc.targetId = target.id;
        npc.targetType = target.type;
      }
    }
    const target = findEntityById(npc.targetId, npc.targetType);
    if (target && !target.dead) {
      const dist = distance(npc, target);
      if (dist > npc.attackRange) {
        npc.destination = { x: target.x, y: target.y };
      } else {
        npc.destination = null;
        handleAttack(npc, target, now);
      }
    } else {
      npc.targetId = null;
      npc.targetType = null;
      if (npc.destination && distance(npc, npc.destination) < 10) {
        npc.pathIndex = Math.min(npc.path.length - 1, npc.pathIndex + 1);
        npc.destination = npc.path[npc.pathIndex];
      }
    }
    moveTowards(npc, npc.destination, deltaMs);
  });
}

function updatePlayers(deltaMs, now) {
  players.forEach((player) => {
    if (player.dead) {
      if (player.respawnAt && now >= player.respawnAt) {
        respawnPlayer(player);
      }
      return;
    }
    if (player.targetId) {
      const target = findEntityById(player.targetId, player.targetType);
      if (target && !target.dead) {
        const dist = distance(player, target);
        if (dist > player.attackRange) {
          player.destination = { x: target.x, y: target.y };
        } else {
          player.destination = null;
          handleAttack(player, target, now);
        }
      } else {
        player.targetId = null;
        player.targetType = null;
      }
    }
    moveTowards(player, player.destination, deltaMs);
  });
}

function updateTowers(now) {
  towers.forEach((tower) => {
    if (tower.dead) return;
    const enemy = nearestEnemyInSight(tower);
    if (enemy) {
      handleAttack(tower, enemy, now);
    }
  });
}

function removeDeadEntities() {
  const toDelete = [];
  npcs.forEach((npc, key) => {
    if (npc.dead) toDelete.push(key);
  });
  toDelete.forEach((id) => npcs.delete(id));
}

function checkWinCondition() {
  const redCrystal = crystals.find((c) => c.team === 'red');
  const blueCrystal = crystals.find((c) => c.team === 'blue');
  if (redCrystal && redCrystal.health <= 0) {
    io.emit('announcement', { message: 'Blue team destroyed the red crystal! Resetting match...' });
    resetWorld();
  } else if (blueCrystal && blueCrystal.health <= 0) {
    io.emit('announcement', { message: 'Red team destroyed the blue crystal! Resetting match...' });
    resetWorld();
  }
}

function spawnWave(now) {
  if (now < nextSpawnAt) return;
  nextSpawnAt = now + NPC_SPAWN_INTERVAL;
  ['red', 'blue'].forEach((team) => {
    Object.keys(LANES).forEach((lane) => {
      for (let i = 0; i < NPCS_PER_SPAWN; i += 1) {
        const type = i % 2 === 0 ? 'melee' : 'ranged';
        const npc = createNPC(team, lane, type, i);
        npcs.set(npc.id, npc);
      }
    });
  });
}

function visibleEntitiesForPlayer(player) {
  const visible = { players: [], npcs: [], towers: [], crystals: [] };
  const addIfVisible = (target, bucket) => {
    if (!target) return;
    const dist = distance(player, target);
    if (dist <= player.sightRange) bucket.push(sanitizeEntity(target));
  };
  players.forEach((p) => {
    if (p.id !== player.id) addIfVisible(p, visible.players);
  });
  npcs.forEach((npc) => addIfVisible(npc, visible.npcs));
  towers.forEach((t) => addIfVisible(t, visible.towers));
  crystals.forEach((c) => addIfVisible(c, visible.crystals));
  return visible;
}

function visibleEntitiesForTeam(team) {
  const buckets = { players: [], npcs: [], towers: [], crystals: [] };
  const addIfVisible = (visionCenter, target, bucket) => {
    const dist = distance(visionCenter, target);
    if (dist <= visionCenter.sightRange && !bucket.some((e) => e.id === target.id)) {
      bucket.push(sanitizeEntity(target));
    }
  };
  players.forEach((viewer) => {
    if (viewer.team !== team || viewer.dead) return;
    players.forEach((p) => {
      if (p.id !== viewer.id) addIfVisible(viewer, p, buckets.players);
    });
    npcs.forEach((npc) => addIfVisible(viewer, npc, buckets.npcs));
    towers.forEach((t) => addIfVisible(viewer, t, buckets.towers));
    crystals.forEach((c) => addIfVisible(viewer, c, buckets.crystals));
  });
  return buckets;
}

function sanitizeEntity(entity) {
  return {
    id: entity.id,
    team: entity.team,
    x: entity.x,
    y: entity.y,
    health: entity.health,
    maxHealth: entity.maxHealth,
    type: entity.type,
    npcType: entity.npcType,
    classKey: entity.classKey,
  };
}

io.on('connection', (socket) => {
  const pendingId = randomUUID();
  const options = randomClassChoices();
  socket.emit('classOptions', { options });

  socket.on('chooseClass', ({ classKey, name }) => {
    if (!CLASSES[classKey]) return;
    const team = assignTeam();
    const player = createPlayer(pendingId, socket.id, team, classKey, name || 'Hero');
    players.set(player.id, player);
    socket.join(team);
    socket.emit('joined', { id: player.id, team, map: { width: MAP_WIDTH, height: MAP_HEIGHT }, classKey });
    socket.emit('announcement', { message: `You joined team ${team}` });
  });

  socket.on('moveTo', ({ x, y }) => {
    const player = players.get(pendingId);
    if (player && !player.dead) {
      player.destination = { x: Math.max(0, Math.min(MAP_WIDTH, x)), y: Math.max(0, Math.min(MAP_HEIGHT, y)) };
    }
  });

  socket.on('attack', ({ id, type }) => {
    const player = players.get(pendingId);
    if (!player || player.dead) return;
    const target = findEntityById(id, type);
    if (target && target.team !== player.team) {
      player.targetId = id;
      player.targetType = type;
    }
  });

  socket.on('disconnect', () => {
    players.delete(pendingId);
  });
});

function emitState(now) {
  players.forEach((player) => {
    const socket = io.sockets.sockets.get(player.socketId);
    if (!socket) return;
    const you = sanitizeEntity(player);
    const visible = player.dead ? visibleEntitiesForTeam(player.team) : visibleEntitiesForPlayer(player);
    socket.emit('state', {
      you,
      visible,
      team: player.team,
      xp: player.xp,
      dead: player.dead,
      respawnIn: player.dead && player.respawnAt ? Math.max(0, player.respawnAt - now) : 0,
      crystals: crystals.map(sanitizeEntity),
      nextSpawnIn: Math.max(0, nextSpawnAt - now),
    });
  });
}

function gameLoop() {
  const now = Date.now();
  const deltaMs = TICK_RATE_MS;
  spawnWave(now);
  updatePlayers(deltaMs, now);
  updateNPCs(deltaMs, now);
  updateTowers(now);
  removeDeadEntities();
  checkWinCondition();
  emitState(now);
}

resetWorld();
setInterval(gameLoop, TICK_RATE_MS);

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
