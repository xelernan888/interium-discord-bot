import "dotenv/config";
import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  PermissionFlagsBits,
  MessageFlags,
  SlashCommandBuilder,
  ChannelType,
} from "discord.js";
import {
  attachLevels,
  setupLevelSystem,
  showLevel,
} from "./levels.js";
import {
  attachProtection,
  clearRaidMode,
  raidStatus,
  setRaidMode,
} from "./protection.js";
import { setupGuild } from "./setup.js";
import {
  TICKET_CLOSE_ID,
  TICKET_CREATE_ID,
  handleTicketClose,
  handleTicketCreate,
  postTicketPanel,
} from "./tickets.js";
import {
  VERIFY_BUTTON_ID,
  handleVerifyButton,
  handleVerifyModal,
  isVerifyModal,
  postVerifyPanel,
} from "./verify.js";

const token = process.env.DISCORD_TOKEN?.trim();
if (!token) {
  console.error("Put DISCORD_TOKEN in .env");
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName("setup")
    .setDescription("Create missing Interium categories and channels")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("verify-panel")
    .setDescription("Post the verification button in this channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("lockdown")
    .setDescription("Anti-raid lockdown on or off")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("on or off")
        .setRequired(true)
        .addChoices(
          { name: "on", value: "on" },
          { name: "off", value: "off" }
        )
    )
    .addIntegerOption((option) =>
      option
        .setName("minutes")
        .setDescription("Lockdown length when turning on (default 20)")
        .setMinValue(5)
        .setMaxValue(180)
    ),
  new SlashCommandBuilder()
    .setName("ticket-panel")
    .setDescription("Post the create-ticket button in a channel")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Channel for the ticket button")
        .addChannelTypes(ChannelType.GuildText)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName("level")
    .setDescription("Your level and XP on this server")
    .setDMPermission(false),
  new SlashCommandBuilder()
    .setName("level-setup")
    .setDescription("Create level roles and chat permissions (Lvl 1/5/10/15)")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),
];

const commandBody = commands.map((command) => command.toJSON());

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

attachProtection(client);
attachLevels(client);

async function registerGuildCommands(appId, guildId) {
  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationGuildCommands(appId, guildId), {
    body: commandBody,
  });
}

client.once(Events.ClientReady, async (ready) => {
  console.log(`Ready as ${ready.user.tag}`);
  console.log(
    "Enable SERVER MEMBERS + MESSAGE CONTENT intents in the Discord Developer Portal."
  );
  if (ready.guilds.cache.size === 0) {
    console.log("Bot is not in any server.");
    return;
  }
  for (const guild of ready.guilds.cache.values()) {
    try {
      await registerGuildCommands(ready.user.id, guild.id);
      console.log(`Registered commands in ${guild.name}`);
    } catch (error) {
      console.error(
        `Failed to register commands in ${guild.name}:`,
        error.message
      );
    }
  }
  console.log(
    "Commands: /setup  /verify-panel  /ticket-panel  /level  /level-setup  /lockdown"
  );
});

client.on(Events.GuildCreate, async (guild) => {
  try {
    await registerGuildCommands(client.user.id, guild.id);
    console.log(`Registered commands in ${guild.name}`);
  } catch (error) {
    console.error(`Failed to register commands in ${guild.name}:`, error.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isButton()) {
      if (interaction.customId === VERIFY_BUTTON_ID) {
        await handleVerifyButton(interaction);
        return;
      }
      if (interaction.customId === TICKET_CREATE_ID) {
        await handleTicketCreate(interaction);
        return;
      }
      if (interaction.customId === TICKET_CLOSE_ID) {
        await handleTicketClose(interaction);
        return;
      }
    }
    if (interaction.isModalSubmit() && isVerifyModal(interaction.customId)) {
      await handleVerifyModal(interaction);
      return;
    }
    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName === "lockdown") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: "Only Administrators.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const mode = interaction.options.getString("mode", true);
      if (mode === "off") {
        await clearRaidMode(interaction.guild);
        await interaction.reply({
          content: "Lockdown disabled.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const minutes = interaction.options.getInteger("minutes") ?? 20;
      await setRaidMode(
        interaction.guild,
        minutes,
        `Manual lockdown by ${interaction.user.tag}`
      );
      await interaction.reply({
        content: `Lockdown on for ${minutes} minutes.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "level") {
      const card = await showLevel(interaction);
      await interaction.reply({
        content: card,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "level-setup") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: "Only Administrators.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await setupLevelSystem(interaction.guild);
      await interaction.editReply(
        [
          "Level system is ready.",
          "Roles: Lvl 1 · Lvl 5 · Lvl 10 · Lvl 15",
          `Roles given: ${result.assigned}. Failed: ${result.failed}.`,
          result.failed
            ? "If failed > 0: put the **bot role above** Lvl 1 / 5 / 10 / 15, then run /level-setup again."
            : "",
          "",
          "**Lvl 1** — text only (GIFs deleted)",
          "**Lvl 5** — GIFs",
          "**Lvl 10** — image uploads",
          "**Lvl 15** — stickers",
        ]
          .filter(Boolean)
          .join("\n")
      );
      return;
    }

    if (interaction.commandName === "ticket-panel") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: "Only server Administrators can run this.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const channel = interaction.options.getChannel("channel", true);
      if (channel.type !== ChannelType.GuildText) {
        await interaction.reply({
          content: "Pick a text channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await postTicketPanel(channel);
      await interaction.reply({
        content: `Ticket button posted in ${channel}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName === "verify-panel") {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
        await interaction.reply({
          content: "Only server Administrators can run this.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const channel = interaction.channel;
      if (!channel || channel.type !== ChannelType.GuildText) {
        await interaction.reply({
          content: "Use this in a text channel.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      await postVerifyPanel(channel);
      await interaction.reply({
        content: "Verification button posted.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (interaction.commandName !== "setup") {
      return;
    }
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
      await interaction.reply({
        content: "Only server Administrators can run /setup.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const result = await setupGuild(interaction.guild);
    const status = raidStatus(interaction.guild.id);
    await interaction.editReply(
      [
        "Roles wiped and recreated. Channel access is set.",
        `New roles: ${result.roles.join(", ")}`,
        `Deleted: ${result.deleted.length ? result.deleted.join(", ") : "none"}`,
        result.skipped.length ? `Skipped: ${result.skipped.join(", ")}` : "",
        `Categories: ${result.categories.join(" · ")}`,
        status.active
          ? `Anti-raid: ON (${Math.ceil(status.remainingMs / 60_000)} min left)`
          : "Anti-raid: off",
        "Give yourself Admin. Bot role must stay at the top.",
      ]
        .filter(Boolean)
        .join("\n")
    );
  } catch (error) {
    const text = String(error?.message || error);
    if (interaction.deferred || interaction.replied) {
      await interaction
        .followUp({ content: text, flags: MessageFlags.Ephemeral })
        .catch(() => {});
      return;
    }
    await interaction
      .reply({ content: text, flags: MessageFlags.Ephemeral })
      .catch(() => {});
  }
});

client.login(token).catch((error) => {
  console.error("Login failed:", error.message);
  process.exit(1);
});
