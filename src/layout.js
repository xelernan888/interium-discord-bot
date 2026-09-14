import { PermissionFlagsBits } from "discord.js";

export const ROLE_SETUP = [
  {
    key: "admin",
    name: "Admin",
    color: 0xe74c3c,
    hoist: true,
    mentionable: false,
    permissions: [PermissionFlagsBits.Administrator],
  },
  {
    key: "support",
    name: "Support",
    color: 0x3498db,
    hoist: true,
    mentionable: true,
    permissions: [
      PermissionFlagsBits.ManageMessages,
      PermissionFlagsBits.EmbedLinks,
      PermissionFlagsBits.AttachFiles,
      PermissionFlagsBits.ReadMessageHistory,
    ],
  },
  {
    key: "client",
    name: "Client",
    color: 0xc9a227,
    hoist: true,
    mentionable: true,
    permissions: [],
  },
];

export const VERIFIED_KEEP_NAMES = new Set([
  "admin",
  "support",
  "client",
  "verefied",
  "verified",
  "verify",
]);

const staffWrite = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ManageMessages,
];

const readOnly = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
];

const memberChat = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
];

export const LAYOUT = [
  {
    name: "PUBLIC",
    access: "public",
    channels: [
      { name: "welcome", mode: "staff" },
      { name: "announcements", mode: "staff" },
      { name: "pricing", mode: "staff" },
      { name: "stock", mode: "staff" },
      { name: "faq", mode: "staff" },
      { name: "rules", mode: "staff" },
    ],
  },
  {
    name: "STORE",
    access: "public",
    channels: [
      { name: "how-to-buy", mode: "staff" },
      { name: "payment", mode: "staff" },
      { name: "redeem", mode: "open" },
      { name: "purchase-help", mode: "open" },
    ],
  },
  {
    name: "CLIENT",
    access: "client",
    channels: [
      { name: "client-news", mode: "staff" },
      { name: "changelog", mode: "staff" },
      { name: "downloads", mode: "staff" },
      { name: "setup", mode: "staff" },
      { name: "status", mode: "staff" },
      { name: "known-issues", mode: "staff" },
    ],
  },
  {
    name: "CLIENT SUPPORT",
    access: "client-chat",
    channels: [
      { name: "support", mode: "chat" },
      { name: "tickets", mode: "chat" },
      { name: "logs", mode: "chat" },
    ],
  },
  {
    name: "COMMUNITY",
    access: "client-chat",
    channels: [
      { name: "general", mode: "chat" },
      { name: "media", mode: "chat" },
      { name: "offtopic", mode: "chat" },
    ],
  },
  {
    name: "STAFF",
    access: "staff",
    channels: [
      { name: "staff", mode: "staff-chat" },
      { name: "staff-sales", mode: "staff-chat" },
      { name: "staff-logs", mode: "staff-chat" },
    ],
  },
];

export function categoryOverwrites(guild, roles, access) {
  const everyone = guild.roles.everyone;
  const { admin, support, client } = roles;

  if (access === "public") {
    return [
      {
        id: everyone.id,
        allow: readOnly,
        deny: [PermissionFlagsBits.SendMessages],
      },
      {
        id: client.id,
        allow: readOnly,
        deny: [PermissionFlagsBits.SendMessages],
      },
      { id: support.id, allow: staffWrite },
      { id: admin.id, allow: staffWrite },
    ];
  }

  if (access === "client") {
    return [
      { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: client.id,
        allow: readOnly,
        deny: [PermissionFlagsBits.SendMessages],
      },
      { id: support.id, allow: staffWrite },
      { id: admin.id, allow: staffWrite },
    ];
  }

  if (access === "client-chat") {
    return [
      { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: client.id, allow: memberChat },
      { id: support.id, allow: staffWrite },
      { id: admin.id, allow: staffWrite },
    ];
  }

  return [
    { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: client.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: support.id, allow: staffWrite },
    { id: admin.id, allow: staffWrite },
  ];
}

export function channelOverwrites(guild, roles, access, mode) {
  const everyone = guild.roles.everyone;
  const { admin, support, client } = roles;
  const base = categoryOverwrites(guild, roles, access);

  if (mode === "open") {
    return [
      { id: everyone.id, allow: memberChat },
      { id: client.id, allow: memberChat },
      { id: support.id, allow: staffWrite },
      { id: admin.id, allow: staffWrite },
    ];
  }

  if (mode === "chat") {
    return [
      { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: client.id, allow: memberChat },
      { id: support.id, allow: staffWrite },
      { id: admin.id, allow: staffWrite },
    ];
  }

  if (mode === "staff-chat") {
    return [
      { id: everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: client.id, deny: [PermissionFlagsBits.ViewChannel] },
      { id: support.id, allow: staffWrite },
      { id: admin.id, allow: staffWrite },
    ];
  }

  return base;
}
