import {
  ChannelType,
  Events,
  PermissionFlagsBits,
} from "discord.js";
const JOIN_THRESHOLD = Math.max(
  2,
  Number.parseInt(process.env.RAID_JOIN_THRESHOLD || "4", 10) || 4
);
const JOIN_WINDOW_MS = Math.max(
  3000,
  Number.parseInt(process.env.RAID_JOIN_WINDOW_MS || "12000", 10) || 12000
);
const RAID_MODE_MS = Math.max(
  60_000,
  Number.parseInt(process.env.RAID_MODE_MS || "1200000", 10) || 1_200_000
);
const SPAM_COUNT = Math.max(
  3,
  Number.parseInt(process.env.RAID_SPAM_COUNT || "5", 10) || 5
);
const SPAM_WINDOW_MS = Math.max(
  2000,
  Number.parseInt(process.env.RAID_SPAM_WINDOW_MS || "4000", 10) || 4000
);
const TIMEOUT_MINUTES = Math.max(
  1,
  Number.parseInt(process.env.RAID_TIMEOUT_MINUTES || "10", 10) || 10
);
const MENTION_LIMIT = Math.max(
  1,
  Number.parseInt(process.env.RAID_MENTION_LIMIT || "3", 10) || 3
);
const DUPLICATE_LIMIT = Math.max(
  2,
  Number.parseInt(process.env.RAID_DUPLICATE_LIMIT || "3", 10) || 3
);

/** @type {Map<string, { joins: number[]; raidUntil: number; messages: Map<string, number[]>; lastText: Map<string, { text: string; count: number }> }>} */
const guilds = new Map();

function stateFor(guildId) {
  let state = guilds.get(guildId);
  if (!state) {
    state = {
      joins: [],
      raidUntil: 0,
      messages: new Map(),
      lastText: new Map(),
    };
    guilds.set(guildId, state);
  }
  return state;
}

function raidActive(guildId) {
  const state = stateFor(guildId);
  if (state.raidUntil > Date.now()) return true;
  if (state.raidUntil !== 0) state.raidUntil = 0;
  return false;
}

function isStaff(member) {
  if (!member) return true;
  if (member.user.bot) return true;
  if (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild) ||
    member.permissions.has(PermissionFlagsBits.ModerateMembers)
  ) {
    return true;
  }
  return false;
}

async function staffLog(guild, text) {
  const channel = guild.channels.cache.find(
    (entry) =>
      entry.type === ChannelType.GuildText &&
      entry.name === "staff-logs"
  );
  if (!channel?.isTextBased()) return;
  await channel.send({ content: text }).catch(() => {});
}

async function timeoutMember(member, minutes, reason) {
  const me = member.guild.members.me;
  if (!me?.permissions.has(PermissionFlagsBits.ModerateMembers)) return;
  if (!member.moderatable) return;
  const ms = minutes * 60 * 1000;
  await member.timeout(ms, reason).catch(() => {});
}

export async function setRaidMode(guild, minutes, reason) {
  const state = stateFor(guild.id);
  const durationMs = Math.max(60_000, minutes * 60 * 1000);
  state.raidUntil = Date.now() + durationMs;

  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;
    if (channel.name === "verify") continue;
    await channel.setRateLimitPerUser(30, "Anti-raid lockdown").catch(() => {});
  }

  await staffLog(
    guild,
    [
      "**Anti-raid activated**",
      `Reason: ${reason}`,
      `Duration: ${Math.round(durationMs / 60_000)} min`,
      "Slowmode 30s on text channels (except verify).",
    ].join("\n")
  );
}

export async function clearRaidMode(guild) {
  const state = stateFor(guild.id);
  state.raidUntil = 0;
  state.joins = [];
  state.messages.clear();
  state.lastText.clear();

  for (const channel of guild.channels.cache.values()) {
    if (channel.type !== ChannelType.GuildText) continue;
    if (channel.rateLimitPerUser > 0) {
      await channel.setRateLimitPerUser(0, "Anti-raid lockdown ended").catch(
        () => {}
      );
    }
  }

  await staffLog(guild, "**Anti-raid ended.** Channels restored.");
}

async function onJoinRaid(member) {
  const guild = member.guild;
  const state = stateFor(guild.id);
  const now = Date.now();
  state.joins = state.joins.filter((at) => now - at < JOIN_WINDOW_MS);
  state.joins.push(now);

  if (state.joins.length < JOIN_THRESHOLD) return;

  state.joins = [];
  await setRaidMode(
    guild,
    Math.round(RAID_MODE_MS / 60_000),
    `${JOIN_THRESHOLD}+ joins in ${Math.round(JOIN_WINDOW_MS / 1000)}s`
  );

  const accountDays =
    (now - member.user.createdTimestamp) / (1000 * 60 * 60 * 24);
  if (accountDays < 7 && member.moderatable) {
    await timeoutMember(
      member,
      TIMEOUT_MINUTES,
      "Join raid — young account"
    );
  }
}

function trackSpam(guildId, userId) {
  const state = stateFor(guildId);
  const now = Date.now();
  const bucket = state.messages.get(userId) ?? [];
  const fresh = bucket.filter((at) => now - at < SPAM_WINDOW_MS);
  fresh.push(now);
  state.messages.set(userId, fresh);
  return fresh.length;
}

function trackDuplicate(guildId, userId, text) {
  const state = stateFor(guildId);
  const key = userId;
  const normalized = text.trim().toLowerCase().slice(0, 200);
  const prev = state.lastText.get(key);
  if (!prev || prev.text !== normalized) {
    state.lastText.set(key, { text: normalized, count: 1 });
    return 1;
  }
  prev.count += 1;
  return prev.count;
}

async function punishSpam(message, reason) {
  await message.delete().catch(() => {});
  if (message.member) {
    await timeoutMember(message.member, TIMEOUT_MINUTES, reason);
  }
  await staffLog(
    message.guild,
    `**Spam blocked** — ${message.author.tag}\n${reason}`
  );
}

async function onMessage(message) {
  if (!message.guild || message.author.bot) return;
  if (message.member && isStaff(message.member)) return;

  if (raidActive(message.guild.id)) {
    await message.delete().catch(() => {});
    if (message.member?.moderatable) {
      await timeoutMember(
        message.member,
        TIMEOUT_MINUTES,
        "Message during anti-raid lockdown"
      );
    }
    return;
  }

  const mentionCount =
    message.mentions.users.size + message.mentions.roles.size;
  const everyone =
    message.mentions.everyone ||
    message.content.includes("@everyone") ||
    message.content.includes("@here");

  if (everyone || mentionCount >= MENTION_LIMIT) {
    await punishSpam(
      message,
      everyone ? "Mass ping" : `Too many mentions (${mentionCount})`
    );
    await setRaidMode(
      message.guild,
      Math.round(RAID_MODE_MS / 60_000),
      `Mention spam by ${message.author.tag}`
    );
    return;
  }

  const duplicateCount = trackDuplicate(
    message.guild.id,
    message.author.id,
    message.content
  );
  if (duplicateCount >= DUPLICATE_LIMIT) {
    await punishSpam(message, "Duplicate spam");
    return;
  }

  const count = trackSpam(message.guild.id, message.author.id);
  if (count >= SPAM_COUNT) {
    stateFor(message.guild.id).messages.set(message.author.id, []);
    await punishSpam(
      message,
      `${SPAM_COUNT} messages in ${Math.round(SPAM_WINDOW_MS / 1000)}s`
    );
    if (count >= SPAM_COUNT + 2) {
      await setRaidMode(
        message.guild,
        Math.round(RAID_MODE_MS / 60_000),
        `Message flood by ${message.author.tag}`
      );
    }
  }
}

export function attachProtection(client) {
  client.on(Events.GuildMemberAdd, async (member) => {
    try {
      await onJoinRaid(member);
    } catch (error) {
      console.error("GuildMemberAdd protection:", error?.message || error);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      await onMessage(message);
    } catch (error) {
      console.error("MessageCreate protection:", error?.message || error);
    }
  });
}

export function raidStatus(guildId) {
  const state = stateFor(guildId);
  const active = raidActive(guildId);
  const remainingMs = active ? state.raidUntil - Date.now() : 0;
  return { active, remainingMs };
}
