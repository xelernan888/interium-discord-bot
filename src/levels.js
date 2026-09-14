import { randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ChannelType,
  Events,
  PermissionFlagsBits,
} from "discord.js";

export const LEVEL_TIERS = [1, 5, 10, 15];

export const LEVEL_CHANNELS = [
  "general",
  "media",
  "offtopic",
  "redeem",
  "purchase-help",
];

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "levels.json");

const XP_MIN = 12;
const XP_MAX = 22;
const COOLDOWN_MS = Math.max(
  15_000,
  Number.parseInt(process.env.LEVEL_COOLDOWN_MS || "45000", 10) || 45_000
);

const baseDeny = [
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.UseExternalEmojis,
  PermissionFlagsBits.UseExternalStickers,
];

const tierPerms = {
  1: [],
  5: [
    PermissionFlagsBits.EmbedLinks,
    PermissionFlagsBits.UseExternalEmojis,
  ],
  10: [PermissionFlagsBits.AttachFiles],
  15: [
    PermissionFlagsBits.UseExternalStickers,
    PermissionFlagsBits.AddReactions,
  ],
};

const tierColors = {
  1: 0x95a5a6,
  5: 0x3498db,
  10: 0x9b59b6,
  15: 0xc9a227,
};

/** @type {Map<string, number>} */
const lastXpAt = new Map();

/** @type {{ guilds: Record<string, Record<string, { xp: number }>> }} */
let store = { guilds: {} };

async function loadStore() {
  try {
    const raw = await readFile(STORE_FILE, "utf8");
    store = JSON.parse(raw);
    if (!store.guilds) store.guilds = {};
  } catch {
    store = { guilds: {} };
  }
}

async function saveStore() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
}

let saveQueued = false;
function queueSave() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(async () => {
    saveQueued = false;
    try {
      await saveStore();
    } catch (error) {
      console.error("levels save failed:", error?.message || error);
    }
  }, 2000);
}

export function xpToReachLevel(level) {
  if (level <= 1) return 0;
  return (level - 1) * 55;
}

export function levelFromXp(xp) {
  let level = 1;
  while (level < 15 && xp >= xpToReachLevel(level + 1)) level += 1;
  return level;
}

export function xpProgress(xp) {
  const level = levelFromXp(xp);
  const current = xpToReachLevel(level);
  const next =
    level >= 15 ? xp : xpToReachLevel(level + 1);
  return { level, xp, current, next };
}

function guildUsers(guildId) {
  if (!store.guilds[guildId]) store.guilds[guildId] = {};
  return store.guilds[guildId];
}

export function getUserXp(guildId, userId) {
  return guildUsers(guildId)[userId]?.xp ?? 0;
}

export function roleNameForTier(tier) {
  return `Lvl ${tier}`;
}

export async function ensureLevelRoles(guild) {
  await guild.roles.fetch();
  const roles = {};
  for (const tier of LEVEL_TIERS) {
    const name = roleNameForTier(tier);
    let role = guild.roles.cache.find((entry) => entry.name === name);
    if (!role) {
      role = await guild.roles.create({
        name,
        color: tierColors[tier],
        hoist: tier === 15,
        mentionable: false,
        permissions: [],
        reason: "Level system",
      });
    } else {
      await role.edit({
        color: tierColors[tier],
        hoist: tier === 15,
      });
    }
    roles[tier] = role;
  }

  const botTop = guild.members.me?.roles.highest.position ?? 1;
  try {
    await guild.roles.setPositions(
      LEVEL_TIERS.map((tier, index) => ({
        role: roles[tier].id,
        position: Math.max(1, botTop - 2 - index),
      }))
    );
  } catch {
    // Bot role must stay above level roles.
  }

  return roles;
}

function chatOverwrite(guild, roles, tier) {
  const everyone = guild.roles.everyone;
  const allow = tierPerms[tier] ?? [];
  const deny = baseDeny.filter((bit) => !allow.includes(bit));
  return {
    id: roles[tier].id,
    allow,
    deny,
  };
}

export async function applyLevelChannelPermissions(guild, roles) {
  await guild.channels.fetch();
  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;
    if (!LEVEL_CHANNELS.includes(channel.name)) continue;

    const everyone = guild.roles.everyone;
    const overwrites = [
      {
        id: everyone.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
        deny: baseDeny,
      },
      chatOverwrite(guild, roles, 5),
      chatOverwrite(guild, roles, 10),
      chatOverwrite(guild, roles, 15),
    ];

    await channel.permissionOverwrites.set(overwrites);
  }
}

function isStaff(member) {
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlagsBits.ManageMessages)
  );
}

export async function syncLevelRoles(member, level) {
  const guild = member.guild;
  const roles = await ensureLevelRoles(guild);
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) return;

  const toAdd = [];
  const toRemove = [];
  for (const tier of LEVEL_TIERS) {
    const role = roles[tier];
    if (!role) continue;
    if (level >= tier) toAdd.push(role);
    else toRemove.push(role);
  }

  if (toRemove.length) await member.roles.remove(toRemove).catch(() => {});
  if (toAdd.length) await member.roles.add(toAdd).catch(() => {});
}

export async function setupLevelSystem(guild) {
  const roles = await ensureLevelRoles(guild);
  await applyLevelChannelPermissions(guild, roles);
  return roles;
}

export async function grantXp(message) {
  if (!message.guild || message.author.bot || !message.member) return null;
  if (isStaff(message.member)) return null;
  if (!LEVEL_CHANNELS.includes(message.channel.name)) return null;

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const last = lastXpAt.get(key) ?? 0;
  if (now - last < COOLDOWN_MS) return null;
  lastXpAt.set(key, now);

  const users = guildUsers(message.guild.id);
  const entry = users[message.author.id] ?? { xp: 0 };
  const gain = randomInt(XP_MIN, XP_MAX + 1);
  const before = entry.xp;
  entry.xp += gain;
  users[message.author.id] = entry;
  queueSave();

  const oldLevel = levelFromXp(before);
  const newLevel = levelFromXp(entry.xp);
  if (newLevel > oldLevel) {
    await syncLevelRoles(message.member, newLevel);
    const unlock =
      newLevel >= 15
        ? "stickers & full media"
        : newLevel >= 10
          ? "image uploads"
          : newLevel >= 5
            ? "GIFs & embeds"
            : "chat";
    try {
      await message.author.send(
        [
          `**Level up** on **${message.guild.name}**`,
          `You are now **level ${newLevel}**.`,
          `Unlocked: **${unlock}**.`,
        ].join("\n")
      );
    } catch {
      // DMs closed
    }
    return { leveledUp: true, level: newLevel, xp: entry.xp };
  }

  if (oldLevel === 1 && before === 0) {
    await syncLevelRoles(message.member, 1);
  }

  return { leveledUp: false, level: newLevel, xp: entry.xp };
}

export function formatLevelCard(guildId, userId, tag) {
  const xp = getUserXp(guildId, userId);
  const { level, current, next } = xpProgress(xp);
  const barLen = 12;
  const span = Math.max(1, next - current);
  const filled = Math.round(((xp - current) / span) * barLen);
  const bar = `${"▰".repeat(filled)}${"▱".repeat(barLen - filled)}`;

  const perks =
    level >= 15
      ? "GIFs · images · stickers · reactions"
      : level >= 10
        ? "GIFs · images"
        : level >= 5
          ? "GIFs & link embeds"
          : "text only (no GIFs/images)";

  return [
    `**${tag}**`,
    `Level **${level}** · **${xp}** XP`,
    `${bar} ${level >= 15 ? "MAX" : `${xp - current}/${next - current} to lvl ${level + 1}`}`,
    `Perks: ${perks}`,
    "",
    "Lvl **5** GIFs · **10** images · **15** full media",
  ].join("\n");
}

export function attachLevels(client) {
  loadStore().catch(() => {});

  client.on(Events.MessageCreate, async (message) => {
    try {
      await grantXp(message);
    } catch (error) {
      console.error("levels:", error?.message || error);
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const xp = getUserXp(member.guild.id, member.id);
      const level = levelFromXp(xp);
      await syncLevelRoles(member, level);
    } catch (error) {
      console.error("levels join:", error?.message || error);
    }
  });
}
