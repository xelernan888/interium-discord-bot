import {
  randomInt,
} from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";

export const VERIFY_BUTTON_ID = "interium_verify";
export const VERIFY_MODAL_ID = "interium_verify_modal";
export const VERIFY_INPUT_ID = "interium_verify_code";

export const VERIFIED_ROLE_NAMES = ["verefied", "verified", "verify"];

const CODE_LENGTH = 6;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const MIN_ACCOUNT_DAYS = Math.max(
  0,
  Number.parseInt(process.env.VERIFY_MIN_ACCOUNT_DAYS || "7", 10) || 7
);

function randomCode() {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export function isVerifyModal(customId) {
  return customId.startsWith(`${VERIFY_MODAL_ID}:`);
}

function expectedCode(customId) {
  return customId.slice(`${VERIFY_MODAL_ID}:`.length).toUpperCase();
}

export async function findVerifiedRole(guild) {
  await guild.roles.fetch();
  return guild.roles.cache.find((role) =>
    VERIFIED_ROLE_NAMES.includes(role.name.toLowerCase().trim())
  );
}

export async function postVerifyPanel(channel) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(VERIFY_BUTTON_ID)
      .setLabel("Verify")
      .setStyle(ButtonStyle.Success)
  );

  return channel.send({
    content: [
      "**Verification**",
      "Press the button and type the code shown in the window.",
      "Until then you cannot see the rest of the server.",
    ].join("\n"),
    components: [row],
  });
}

export async function handleVerifyButton(interaction) {
  const role = await findVerifiedRole(interaction.guild);
  if (!role) {
    await interaction.reply({
      content: "Role `verefied` was not found.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.member.roles.cache.has(role.id)) {
    await interaction.reply({
      content: "You are already verified.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const ageDays =
    (Date.now() - interaction.user.createdTimestamp) / (1000 * 60 * 60 * 24);
  if (ageDays < MIN_ACCOUNT_DAYS) {
    await interaction.reply({
      content: `Account must be at least ${MIN_ACCOUNT_DAYS} days old.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const code = randomCode();
  const modal = new ModalBuilder()
    .setCustomId(`${VERIFY_MODAL_ID}:${code}`)
    .setTitle("Verification")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(VERIFY_INPUT_ID)
          .setLabel(`Type: ${code}`)
          .setStyle(TextInputStyle.Short)
          .setMinLength(CODE_LENGTH)
          .setMaxLength(CODE_LENGTH)
          .setPlaceholder(code)
          .setRequired(true)
      )
    );

  await interaction.showModal(modal);
}

export async function handleVerifyModal(interaction) {
  const code = expectedCode(interaction.customId);
  const value = interaction.fields
    .getTextInputValue(VERIFY_INPUT_ID)
    .trim()
    .toUpperCase()
    .replaceAll(" ", "");

  if (!code || value !== code) {
    await interaction.reply({
      content: "Wrong code. Press Verify again for a new one.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const role = await findVerifiedRole(interaction.guild);
  if (!role) {
    await interaction.reply({
      content: "Role `verefied` was not found.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (interaction.member.roles.cache.has(role.id)) {
    await interaction.reply({
      content: "You are already verified.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const me = interaction.guild.members.me;
  if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await interaction.reply({
      content: "Bot needs Manage Roles.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }
  if (role.position >= me.roles.highest.position) {
    await interaction.reply({
      content: "Move the bot role above `verefied`.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.member.roles.add(role, "Verification");
  await interaction.reply({
    content: "Verified. You now have access.",
    flags: MessageFlags.Ephemeral,
  });
}
