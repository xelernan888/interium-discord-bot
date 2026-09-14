import { randomInt } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ChannelType,
  Events,
  OverwriteType,
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

const STAFF_ROLE_NAMES = new Set(["admin", "owner", "support"]);

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "levels.json");

const XP_MIN = 12;
const XP_MAX = 22;
const COOLDOWN_MS = Math.max(
  15_000,
  Number.parseInt(process.env.LEVEL_COOLDOWN_MS || "45000", 10) || 45_000
);

const MEDIA_FALSE = {
  AttachFiles: false,
  EmbedLinks: false,
  UseExternalEmojis: false,
  UseExternalStickers: false,
};

const GIF_HOST =
  /tenor\.com|giphy\.com|gfycat\.com|redgifs\.com|media\.tenor|tenor\.googleapis/i;

const IMAGE_FILE = /\.(png|jpe?g|webp|bmp|heic|tiff?)$/i;
const GIF_FILE = /\.gif$/i;
const VIDEO_FILE = /\.(mp4|webm|mov|mkv)$/i;

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
  const next = level >= 15 ? xp : xpToReachLevel(level + 1);
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

function isStaffMember(member) {
  if (!member) return false;
  return (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  );
}

function skipLevelChannel(channel) {
  if (!channel || channel.type !== ChannelType.GuildText) return true;
  const name = channel.name.toLowerCase();
  if (name.startsWith("ticket-")) return true;
  if (name === "verify" || name === "staff" || name === "staff-sales") {
    return true;
  }
  if (name === "staff-logs" || name === "tickets") return true;
  return false;
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
        hoist: false,
        mentionable: false,
        permissions: [],
        reason: "Level system",
      });
    }
    roles[tier] = role;
  }
  return roles;
}

export async function applyLevelChannelPermissions(guild, roles) {
  await guild.channels.fetch();
  const staffIds = new Set(
    [...guild.roles.cache.values()]
      .filter((role) => STAFF_ROLE_NAMES.has(role.name.toLowerCase().trim()))
      .map((role) => role.id)
  );
  const levelIds = new Set(Object.values(roles).map((role) => role.id));

  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;
    if (!LEVEL_CHANNELS.includes(channel.name)) continue;

    await channel.permissionOverwrites.edit(guild.id, MEDIA_FALSE);

    for (const overwrite of channel.permissionOverwrites.cache.values()) {
      if (overwrite.type !== OverwriteType.Role) continue;
      if (overwrite.id === guild.id) continue;
      if (levelIds.has(overwrite.id)) continue;
      if (staffIds.has(overwrite.id)) continue;
      await channel.permissionOverwrites.edit(overwrite.id, MEDIA_FALSE);
    }

    await channel.permissionOverwrites.edit(roles[1].id, MEDIA_FALSE);
    await channel.permissionOverwrites.edit(roles[5].id, {
      EmbedLinks: true,
      UseExternalEmojis: true,
      AttachFiles: false,
      UseExternalStickers: false,
    });
    await channel.permissionOverwrites.edit(roles[10].id, {
      AttachFiles: true,
      EmbedLinks: true,
    });
    await channel.permissionOverwrites.edit(roles[15].id, {
      UseExternalStickers: true,
      AttachFiles: true,
      EmbedLinks: true,
    });
  }
}

function botCanManageRole(me, role) {
  if (!me) return false;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) return false;
  return me.roles.highest.position > role.position;
}

export async function syncLevelRoles(member, level) {
  if (!member || member.user.bot) return "skip";
  const guild = member.guild;
  const roles = await ensureLevelRoles(guild);
  const me = guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ManageRoles)) {
    console.error("levels: bot needs Manage Roles");
    return "no-perm";
  }

  const toAdd = [];
  const toRemove = [];
  for (const tier of LEVEL_TIERS) {
    const role = roles[tier];
    if (!role) continue;
    if (!botCanManageRole(me, role)) {
      console.error(
        `levels: move bot role above "${role.name}" (now it cannot assign it)`
      );
      continue;
    }
    if (level >= tier) toAdd.push(role);
    else toRemove.push(role);
  }

  const have = member.roles.cache;
  const addNow = toAdd.filter((role) => !have.has(role.id));
  const removeNow = toRemove.filter((role) => have.has(role.id));

  if (removeNow.length) {
    await member.roles.remove(removeNow, "Level sync");
  }
  if (addNow.length) {
    await member.roles.add(addNow, "Level sync");
  }
  return "ok";
}

export async function setupLevelSystem(guild) {
  const roles = await ensureLevelRoles(guild);
  await applyLevelChannelPermissions(guild, roles);

  await guild.members.fetch();
  let assigned = 0;
  let failed = 0;
  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    try {
      const level = levelFromXp(getUserXp(guild.id, member.id));
      const result = await syncLevelRoles(member, level);
      if (result === "ok") assigned += 1;
      else failed += 1;
    } catch (error) {
      failed += 1;
      console.error("levels assign:", error?.message || error);
    }
  }

  return { roles, assigned, failed };
}

function collectUrls(message) {
  const parts = [message.content ?? ""];
  for (const embed of message.embeds) {
    parts.push(
      embed.url ?? "",
      embed.image?.url ?? "",
      embed.thumbnail?.url ?? "",
      embed.video?.url ?? "",
      embed.provider?.url ?? "",
      embed.provider?.name ?? ""
    );
  }
  for (const attachment of message.attachments.values()) {
    parts.push(attachment.url ?? "", attachment.name ?? "");
  }
  return parts.join(" ");
}

function isGifAttachment(attachment) {
  const name = attachment.name ?? "";
  const type = attachment.contentType ?? "";
  return type.includes("gif") || GIF_FILE.test(name);
}

function isImageAttachment(attachment) {
  const name = attachment.name ?? "";
  const type = attachment.contentType ?? "";
  if (isGifAttachment(attachment)) return false;
  return type.startsWith("image/") || IMAGE_FILE.test(name);
}

function isVideoAttachment(attachment) {
  const name = attachment.name ?? "";
  const type = attachment.contentType ?? "";
  return type.startsWith("video/") || VIDEO_FILE.test(name);
}

function mediaViolation(message, level) {
  const urls = collectUrls(message);
  const hasGifLink = GIF_HOST.test(urls);
  const hasSticker = message.stickers.size > 0;
  const files = [...message.attachments.values()];
  const hasGifFile = files.some(isGifAttachment);
  const hasImage = files.some(isImageAttachment);
  const hasVideo = files.some(isVideoAttachment);
  const hasOtherFile = files.some(
    (file) =>
      !isGifAttachment(file) && !isImageAttachment(file) && !isVideoAttachment(file)
  );

  if (level < 5 && (hasGifLink || hasGifFile)) {
    return "GIFs unlock at **Lvl 5**.";
  }
  if (level < 10 && (hasImage || hasVideo || hasOtherFile)) {
    return "Image / file uploads unlock at **Lvl 10**.";
  }
  if (level < 15 && hasSticker) {
    return "Stickers unlock at **Lvl 15**.";
  }
  if (level < 5 && files.length) {
    return "Uploads unlock at **Lvl 10**. GIFs at **Lvl 5**.";
  }
  return null;
}

export async function enforceMedia(message) {
  if (!message.guild || message.author.bot) return false;
  if (skipLevelChannel(message.channel)) return false;

  const member =
    message.member ??
    (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member || isStaffMember(member)) return false;

  const level = levelFromXp(getUserXp(message.guild.id, message.author.id));
  const reason = mediaViolation(message, level);
  if (!reason) return false;

  await message.delete().catch(() => {});
  await message.channel
    .send({
      content: `${message.author} ${reason} Check \`/level\`.`,
    })
    .then((notice) => {
      setTimeout(() => notice.delete().catch(() => {}), 8000);
    })
    .catch(() => {});
  return true;
}

export async function grantXp(message) {
  if (!message.guild || message.author.bot) return null;
  if (skipLevelChannel(message.channel)) return null;

  const member =
    message.member ??
    (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member) return null;

  const users = guildUsers(message.guild.id);
  const entry = users[message.author.id] ?? { xp: 0 };
  const before = entry.xp;
  const oldLevel = levelFromXp(before);

  const key = `${message.guild.id}:${message.author.id}`;
  const now = Date.now();
  const last = lastXpAt.get(key) ?? 0;
  const canGain = now - last >= COOLDOWN_MS && !isStaffMember(member);

  if (canGain) {
    lastXpAt.set(key, now);
    entry.xp += randomInt(XP_MIN, XP_MAX + 1);
    users[message.author.id] = entry;
    queueSave();
  } else if (!users[message.author.id]) {
    users[message.author.id] = entry;
    queueSave();
  }

  const newLevel = levelFromXp(entry.xp);
  try {
    await syncLevelRoles(member, newLevel);
  } catch (error) {
    console.error("levels sync:", error?.message || error);
  }

  if (canGain && newLevel > oldLevel) {
    const unlock =
      newLevel >= 15
        ? "stickers & full media"
        : newLevel >= 10
          ? "image uploads"
          : newLevel >= 5
            ? "GIFs"
            : "chat";
    await message.channel
      .send(`${member} reached **level ${newLevel}** — unlocked ${unlock}.`)
      .catch(() => {});
  }

  return { level: newLevel, xp: entry.xp };
}

export function formatLevelCard(guildId, userId, tag) {
  const xp = getUserXp(guildId, userId);
  const { level, current, next } = xpProgress(xp);
  const barLen = 12;
  const span = Math.max(1, next - current);
  const filled = Math.min(
    barLen,
    Math.max(0, Math.round(((xp - current) / span) * barLen))
  );
  const bar = `${"▰".repeat(filled)}${"▱".repeat(barLen - filled)}`;

  const perks =
    level >= 15
      ? "GIFs · images · stickers"
      : level >= 10
        ? "GIFs · images"
        : level >= 5
          ? "GIFs (no image uploads)"
          : "text only";

  return [
    `**${tag}**`,
    `Level **${level}** · **${xp}** XP`,
    `${bar} ${level >= 15 ? "MAX" : `${xp - current}/${next - current} to lvl ${level + 1}`}`,
    `Perks: ${perks}`,
    "",
    "Lvl **5** GIFs · **10** images · **15** stickers",
  ].join("\n");
}

export async function showLevel(interaction) {
  const member =
    interaction.member ??
    (await interaction.guild.members.fetch(interaction.user.id));
  const level = levelFromXp(getUserXp(interaction.guild.id, interaction.user.id));
  try {
    await syncLevelRoles(member, level);
  } catch (error) {
    console.error("levels /level:", error?.message || error);
  }
  return formatLevelCard(
    interaction.guild.id,
    interaction.user.id,
    interaction.user.tag
  );
}

export function attachLevels(client) {
  loadStore().catch(() => {});

  client.on(Events.MessageCreate, async (message) => {
    try {
      const removed = await enforceMedia(message);
      if (removed) return;
      await grantXp(message);
    } catch (error) {
      console.error("levels:", error?.message || error);
    }
  });

  client.on(Events.MessageUpdate, async (_old, message) => {
    try {
      if (message.partial) await message.fetch().catch(() => null);
      await enforceMedia(message);
    } catch (error) {
      console.error("levels update:", error?.message || error);
    }
  });

  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      const level = levelFromXp(getUserXp(member.guild.id, member.id));
      await syncLevelRoles(member, level);
    } catch (error) {
      console.error("levels join:", error?.message || error);
    }
  });
}
