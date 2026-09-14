import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";

export const TICKET_CREATE_ID = "interium_ticket_open";
export const TICKET_CLOSE_ID = "interium_ticket_close";

const TICKET_CATEGORY_NAME = "TICKETS";
const OWNER_ROLE_NAMES = ["owner", "admin"];
const SUPPORT_ROLE_NAMES = ["support"];

const staffAccess = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.ManageMessages,
];

const memberAccess = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.EmbedLinks,
];

function findRole(guild, names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return guild.roles.cache.find((role) =>
    wanted.has(role.name.toLowerCase().trim())
  );
}

export async function findTicketStaffRoles(guild) {
  await guild.roles.fetch();
  return {
    owner: findRole(guild, OWNER_ROLE_NAMES),
    support: findRole(guild, SUPPORT_ROLE_NAMES),
  };
}

function ticketTopic(userId) {
  return `ticket-owner:${userId}`;
}

function parseTicketOwner(topic) {
  if (!topic?.startsWith("ticket-owner:")) return null;
  return topic.slice("ticket-owner:".length);
}

export function findOpenTicket(guild, userId) {
  return guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      parseTicketOwner(channel.topic) === userId
  );
}

async function ensureTicketCategory(guild) {
  const existing = guild.channels.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildCategory &&
      channel.name === TICKET_CATEGORY_NAME
  );
  if (existing) return existing;

  const everyone = guild.roles.everyone;
  const { owner, support } = await findTicketStaffRoles(guild);
  const overwrites = [
    {
      id: everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
  ];
  if (owner) overwrites.push({ id: owner.id, allow: staffAccess });
  if (support) overwrites.push({ id: support.id, allow: staffAccess });

  return guild.channels.create({
    name: TICKET_CATEGORY_NAME,
    type: ChannelType.GuildCategory,
    permissionOverwrites: overwrites,
    reason: "Ticket category",
  });
}

function channelSlug(username) {
  const slug = username
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  return slug || "user";
}

export async function postTicketPanel(channel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_CREATE_ID)
      .setLabel("Create ticket")
      .setStyle(ButtonStyle.Primary)
  );

  return channel.send({
    content: [
      "**Support tickets**",
      "Press the button below to open a private ticket.",
      "Only you, **Owner**, and **Support** will see it.",
    ].join("\n"),
    components: [row],
  });
}

export async function handleTicketCreate(interaction) {
  const guild = interaction.guild;
  const me = guild.members.me;
  if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
    await interaction.reply({
      content: "Bot needs **Manage Channels**.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const { owner, support } = await findTicketStaffRoles(guild);
  if (!owner && !support) {
    await interaction.reply({
      content: "Create roles **Owner** (or Admin) and **Support** first.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const existing = findOpenTicket(guild, interaction.user.id);
  if (existing) {
    await interaction.reply({
      content: `You already have a ticket: ${existing}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const category = await ensureTicketCategory(guild);
  const everyone = guild.roles.everyone;
  const overwrites = [
    {
      id: everyone.id,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    {
      id: interaction.user.id,
      allow: memberAccess,
    },
    {
      id: me.id,
      allow: [
        ...staffAccess,
        PermissionFlagsBits.ManageChannels,
      ],
    },
  ];
  if (owner) overwrites.push({ id: owner.id, allow: staffAccess });
  if (support) overwrites.push({ id: support.id, allow: staffAccess });

  const name = `ticket-${channelSlug(interaction.user.username)}`;
  const ticket = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: ticketTopic(interaction.user.id),
    permissionOverwrites: overwrites,
    reason: `Ticket opened by ${interaction.user.tag}`,
  });

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_ID)
      .setLabel("Close ticket")
      .setStyle(ButtonStyle.Danger)
  );

  await ticket.send({
    content: [
      `${interaction.user}`,
      owner ? `${owner}` : "",
      support ? `${support}` : "",
      "",
      "Describe your issue. Staff will reply here.",
    ]
      .filter(Boolean)
      .join("\n"),
    components: [closeRow],
  });

  await interaction.editReply({
    content: `Ticket created: ${ticket}`,
  });
}

function canCloseTicket(member, channel) {
  const ownerId = parseTicketOwner(channel.topic);
  if (!ownerId) return false;
  if (member.id === ownerId) return true;
  if (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageChannels)
  ) {
    return true;
  }
  const { owner, support } = {
    owner: findRole(member.guild, OWNER_ROLE_NAMES),
    support: findRole(member.guild, SUPPORT_ROLE_NAMES),
  };
  if (owner && member.roles.cache.has(owner.id)) return true;
  if (support && member.roles.cache.has(support.id)) return true;
  return false;
}

export async function handleTicketClose(interaction) {
  const channel = interaction.channel;
  if (!channel || channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: "Use this inside a ticket channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ownerId = parseTicketOwner(channel.topic);
  if (!ownerId) {
    await interaction.reply({
      content: "This is not a ticket channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!canCloseTicket(interaction.member, channel)) {
    await interaction.reply({
      content: "Only the ticket owner or staff can close this.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: "Closing ticket in 3 seconds…",
  });
  setTimeout(() => {
    channel.delete("Ticket closed").catch(() => {});
  }, 3000);
}
