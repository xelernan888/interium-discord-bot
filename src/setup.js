import { ChannelType, PermissionFlagsBits } from "discord.js";
import {
  LAYOUT,
  ROLE_SETUP,
  VERIFIED_KEEP_NAMES,
  categoryOverwrites,
  channelOverwrites,
} from "./layout.js";

async function wipeCustomRoles(guild) {
  await guild.roles.fetch();
  const botTop = guild.members.me.roles.highest.position;
  const deleted = [];
  const skipped = [];

  const roles = [...guild.roles.cache.values()]
    .filter((role) => role.id !== guild.id)
    .sort((a, b) => b.position - a.position);

  for (const role of roles) {
    if (role.managed) {
      skipped.push(`${role.name} (managed)`);
      continue;
    }
    if (VERIFIED_KEEP_NAMES.has(role.name.toLowerCase().trim())) {
      skipped.push(`${role.name} (kept)`);
      continue;
    }
    if (role.position >= botTop) {
      skipped.push(`${role.name} (above the bot)`);
      continue;
    }
    try {
      await role.delete("Interium role reset");
      deleted.push(role.name);
    } catch (error) {
      skipped.push(`${role.name} (${error.message})`);
    }
  }

  return { deleted, skipped };
}

async function createRoles(guild) {
  const roles = {};
  for (const spec of ROLE_SETUP) {
    const existing = guild.roles.cache.find(
      (role) => role.name === spec.name && !role.managed
    );
    if (existing) {
      roles[spec.key] = existing;
      continue;
    }
    roles[spec.key] = await guild.roles.create({
      name: spec.name,
      color: spec.color,
      hoist: spec.hoist,
      mentionable: spec.mentionable,
      permissions: spec.permissions,
      reason: "Interium roles",
    });
  }

  const botTop = guild.members.me.roles.highest.position;
  try {
    await guild.roles.setPositions(
      [roles.admin, roles.support, roles.client].map((role, index) => ({
        role: role.id,
        position: Math.max(1, botTop - 1 - index),
      }))
    );
  } catch {
    // Bot role must sit above Admin / Support / Client.
  }

  return roles;
}

async function ensureCategory(guild, name, overwrites) {
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildCategory && channel.name === name
  );
  if (existing) {
    await existing.permissionOverwrites.set(overwrites);
    return existing;
  }
  return guild.channels.create({
    name,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
    reason: "Interium server layout",
  });
}

async function ensureTextChannel(guild, parent, name, overwrites, position) {
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      channel.name === name &&
      channel.parentId === parent.id
  );
  if (existing) {
    await existing.permissionOverwrites.set(overwrites);
    if (existing.position !== position) {
      await existing.setPosition(position);
    }
    return existing;
  }
  return guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: parent.id,
    permissionOverwrites: overwrites,
    position,
    reason: "Interium server layout",
  });
}

export async function setupGuild(guild) {
  const me = guild.members.me;
  if (
    !me.permissions.has(PermissionFlagsBits.Administrator) &&
    !(
      me.permissions.has(PermissionFlagsBits.ManageRoles) &&
      me.permissions.has(PermissionFlagsBits.ManageChannels)
    )
  ) {
    throw new Error(
      "Bot needs Administrator, or Manage Roles + Manage Channels. Put the bot role at the top."
    );
  }

  await guild.channels.fetch();
  const wipe = await wipeCustomRoles(guild);
  const roles = await createRoles(guild);

  for (const [categoryIndex, category] of LAYOUT.entries()) {
    const parent = await ensureCategory(
      guild,
      category.name,
      categoryOverwrites(guild, roles, category.access)
    );
    await parent.setPosition(categoryIndex);

    for (const [channelIndex, channel] of category.channels.entries()) {
      await ensureTextChannel(
        guild,
        parent,
        channel.name,
        channelOverwrites(guild, roles, category.access, channel.mode),
        channelIndex
      );
    }
  }

  return {
    deleted: wipe.deleted,
    skipped: wipe.skipped,
    roles: ROLE_SETUP.map((spec) => spec.name),
    categories: LAYOUT.map((category) => category.name),
  };
}
