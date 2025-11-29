const socket = io();
const colors = { red: 0xeb5757, blue: 0x56ccf2, neutral: 0xffffff };

let playerId = null;
let team = null;
let mapSize = { width: 4000, height: 2400 };
let classKey = null;
let latestState = null;

window.addEventListener('contextmenu', (e) => e.preventDefault());

const announcementEl = document.getElementById('announcement');
const classPanel = document.getElementById('class-select');
const classButtons = document.getElementById('class-buttons');
const hudTeam = document.getElementById('hud-team');
const hudClass = document.getElementById('hud-class');
const hudHealth = document.getElementById('hud-health');
const hudXP = document.getElementById('hud-xp');
const hudRespawn = document.getElementById('hud-respawn');
const hudWave = document.getElementById('hud-wave');

socket.on('announcement', ({ message }) => {
  announcementEl.textContent = message;
});

socket.on('classOptions', ({ options }) => {
  classPanel.classList.remove('hidden');
  classButtons.innerHTML = '';
  options.forEach((key) => {
    const btn = document.createElement('button');
    btn.className = 'button';
    btn.textContent = key.toUpperCase();
    btn.onclick = () => {
      socket.emit('chooseClass', { classKey: key });
      classPanel.classList.add('hidden');
    };
    classButtons.appendChild(btn);
  });
});

socket.on('joined', ({ id, team: joinedTeam, map, classKey: chosenClass }) => {
  playerId = id;
  team = joinedTeam;
  classKey = chosenClass;
  mapSize = map;
  hudTeam.textContent = `Team: ${team}`;
  hudClass.textContent = `Class: ${classKey}`;
});

socket.on('matchReset', ({ team: newTeam, message }) => {
  team = newTeam;
  hudTeam.textContent = `Team: ${team}`;
  announcementEl.textContent = message;
});

socket.on('state', (data) => {
  latestState = data;
  const { you, xp, respawnIn, nextSpawnIn } = data;
  hudHealth.textContent = `HP: ${Math.round(you.health)}/${you.maxHealth}`;
  hudXP.textContent = `XP: ${xp}`;
  hudRespawn.textContent = respawnIn > 0 ? `Respawn in ${(respawnIn / 1000).toFixed(1)}s` : '';
  hudWave.textContent = `Next wave: ${(nextSpawnIn / 1000).toFixed(0)}s`;
  if (you) {
    mapScene?.setPlayerPosition(you.x, you.y);
  }
});

let mapScene;

const config = {
  type: Phaser.AUTO,
  parent: 'game',
  backgroundColor: '#0b0f1a',
  width: window.innerWidth,
  height: window.innerHeight,
  physics: { default: 'arcade' },
  scene: {
    preload() {},
    create,
    update,
  },
};

const game = new Phaser.Game(config);

function create() {
  mapScene = this;
  this.graphics = this.add.graphics();
  this.cameras.main.setBounds(0, 0, mapSize.width, mapSize.height);
  this.input.on('pointerdown', handlePointerDown);
  this.cursors = this.input.keyboard.addKeys({
    w: Phaser.Input.Keyboard.KeyCodes.W,
    a: Phaser.Input.Keyboard.KeyCodes.A,
    s: Phaser.Input.Keyboard.KeyCodes.S,
    d: Phaser.Input.Keyboard.KeyCodes.D,
  });
}

function handlePointerDown(pointer) {
  if (!latestState?.you) return;
  const worldPoint = pointer.positionToCamera(this.cameras.main);
  if (pointer.rightButtonDown()) {
    const target = findNearestEnemy(worldPoint.x, worldPoint.y);
    if (target) {
      socket.emit('attack', { id: target.id, type: target.type });
    }
  } else {
    socket.emit('moveTo', { x: worldPoint.x, y: worldPoint.y });
  }
}

function findNearestEnemy(x, y) {
  if (!latestState) return null;
  const { visible } = latestState;
  const all = [...visible.players, ...visible.npcs, ...visible.towers, ...visible.crystals];
  let closest = null;
  let dist = Infinity;
  all.forEach((entity) => {
    if (entity.team === team) return;
    const dx = entity.x - x;
    const dy = entity.y - y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < dist && d < 600) {
      closest = entity;
      dist = d;
    }
  });
  return closest;
}

function drawEntity(graphics, entity, you) {
  const isFriendly = entity.team === team;
  const size = entity.type === 'player' ? 16 : entity.type === 'npc' ? 10 : entity.type === 'tower' ? 22 : 28;
  const color = isFriendly ? colors.blue : colors.red;
  graphics.fillStyle(color, 1);
  graphics.fillCircle(entity.x, entity.y, size);
  graphics.lineStyle(3, 0xffffff, 0.7);
  graphics.strokeCircle(entity.x, entity.y, size);
  if (entity.type === 'player' && entity.id === you.id) {
    graphics.lineStyle(2, 0xffff00, 0.8);
    graphics.strokeCircle(entity.x, entity.y, size + 6);
  }
  if (entity.maxHealth) {
    const barWidth = size * 2;
    const pct = Math.max(0, entity.health) / entity.maxHealth;
    graphics.fillStyle(0x222222, 0.8);
    graphics.fillRect(entity.x - size, entity.y - size - 8, barWidth, 6);
    graphics.fillStyle(isFriendly ? 0x66ff99 : 0xff6b6b, 0.9);
    graphics.fillRect(entity.x - size, entity.y - size - 8, barWidth * pct, 6);
  }
}

function drawLanes(graphics) {
  graphics.lineStyle(2, 0x333b4d, 0.6);
  ['top', 'mid', 'bot'].forEach((lane, index) => {
    const y = mapSize.height * (0.25 + index * 0.25);
    graphics.beginPath();
    graphics.moveTo(300, y);
    graphics.lineTo(mapSize.width - 300, y);
    graphics.strokePath();
  });
}

function update() {
  const graphics = this.graphics;
  graphics.clear();
  drawLanes(graphics);

  if (!latestState?.you) return;
  const { you, visible, crystals } = latestState;
  const entities = [
    ...visible.players,
    ...visible.npcs,
    ...visible.towers,
    ...crystals,
  ];

  entities.forEach((e) => drawEntity(graphics, e, you));

  this.cameras.main.startFollow({ x: you.x, y: you.y }, false, 0.08, 0.08);
}

window.addEventListener('resize', () => {
  game.scale.resize(window.innerWidth, window.innerHeight);
});

export function setPlayerPosition(x, y) {
  if (mapScene) {
    mapScene.cameras.main.centerOn(x, y);
  }
}
