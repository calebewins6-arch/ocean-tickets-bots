const express = require('express');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let botClient = null;
const guildConfigs = {}; // stores staffRoles per guild

// ─── Connect Bot ────────────────────────────────────────────────────────────
app.post('/api/connect', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Token is required.' });

  if (botClient) {
    botClient.removeAllListeners('interactionCreate');
    botClient.destroy();
    botClient = null;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  });

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Connection timed out. Check your token.')), 15000);
      client.once('ready', () => { clearTimeout(timeout); resolve(); });
      client.login(token).catch((err) => { clearTimeout(timeout); reject(err); });
    });

    botClient = client;

    client.on('interactionCreate', async (interaction) => {
      if (!interaction.isButton()) return;
      try {
        if (interaction.customId.startsWith('os_ticket_')) {
          await handleCreateTicket(interaction, interaction.customId.replace('os_ticket_', ''));
        } else if (interaction.customId === 'os_close') {
          await handleCloseTicket(interaction);
        }
      } catch (err) {
        console.error('[Interaction Error]', err.message);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: '❌ Something went wrong. Please try again.', ephemeral: true }).catch(() => {});
        }
      }
    });

    res.json({ success: true, username: client.user.tag, avatarURL: client.user.displayAvatarURL() });
  } catch (err) {
    client.destroy();
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── Ticket Creation ─────────────────────────────────────────────────────────
async function handleCreateTicket(interaction, type) {
  const guild = interaction.guild;

  const existing = guild.channels.cache.find(
    (c) => c.name === `ticket-${interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}`
  );
  if (existing) {
    return interaction.reply({ content: `❌ You already have an open ticket: ${existing}`, ephemeral: true });
  }

  const labels = {
    general: { emoji: '🎫', name: 'General Support' },
    scrim:   { emoji: '🎮', name: 'Scrim Request'   },
    report:  { emoji: '⚖️',  name: 'Report / Appeal' },
    partner: { emoji: '🤝', name: 'Partnership'     },
  };
  const category = labels[type] || labels.general;

  const config = guildConfigs[guild.id] || {};
  const staffRoles = config.staffRoles || [];

  const permissionOverwrites = [
    { id: guild.id,            deny:  [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
  ];

  // Give each selected staff role access
  for (const roleId of staffRoles) {
    permissionOverwrites.push({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ],
    });
  }

  const safeUsername = interaction.user.username.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
  const ticketChannel = await guild.channels.create({
    name: `ticket-${safeUsername}`,
    type: ChannelType.GuildText,
    permissionOverwrites,
  });

  // Mention staff roles in the ticket
  const staffMentions = staffRoles.map(r => `<@&${r}>`).join(' ');

  const embed = new EmbedBuilder()
    .setColor(config.embedColor ? parseInt(config.embedColor.replace('#', ''), 16) : 0x00b4ff)
    .setTitle(`${category.emoji} ${category.name}`)
    .setDescription(
      `Hey ${interaction.user}! 👋\n\n` +
      `Welcome to your private support channel. Our staff team will be with you shortly.\n\n` +
      `> 📝 Please describe your issue in detail below\n` +
      `> 📸 Attach screenshots if helpful\n` +
      `> ⏳ Average staff response: **< 2 hours**`
    )
    .addFields(
      { name: '👤 Opened By', value: `${interaction.user.tag}`,              inline: true },
      { name: '📋 Category',  value: `${category.emoji} ${category.name}`,   inline: true },
      { name: '🕐 Created',   value: `<t:${Math.floor(Date.now() / 1000)}:R>`, inline: true },
    )
    .setFooter({ text: 'Ocean Scrims Support • Click 🔒 to close this ticket' })
    .setTimestamp();

  const closeRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('os_close').setLabel('🔒 Close Ticket').setStyle(ButtonStyle.Danger)
  );

  const content = [interaction.user.toString(), staffMentions].filter(Boolean).join(' ');
  await ticketChannel.send({ content, embeds: [embed], components: [closeRow] });
  await interaction.reply({ content: `✅ Your ticket has been created: ${ticketChannel}`, ephemeral: true });
}

// ─── Ticket Close ─────────────────────────────────────────────────────────────
async function handleCloseTicket(interaction) {
  const embed = new EmbedBuilder()
    .setColor(0xff3355)
    .setTitle('🔒 Ticket Closing')
    .setDescription(`This ticket was closed by ${interaction.user}.\nThis channel will be **deleted in 5 seconds**.`)
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
  setTimeout(() => interaction.channel.delete().catch(() => {}), 5000);
}

// ─── Get Guilds ──────────────────────────────────────────────────────────────
app.get('/api/guilds', (req, res) => {
  if (!botClient) return res.status(400).json({ success: false, error: 'Bot not connected.' });
  const guilds = botClient.guilds.cache.map((g) => ({ id: g.id, name: g.name, icon: g.iconURL() }));
  res.json({ success: true, guilds });
});

// ─── Get Text Channels ────────────────────────────────────────────────────────
app.get('/api/channels/:guildId', async (req, res) => {
  if (!botClient) return res.status(400).json({ success: false, error: 'Bot not connected.' });
  try {
    const guild = await botClient.guilds.fetch(req.params.guildId);
    await guild.channels.fetch();
    const channels = guild.channels.cache
      .filter((c) => c.type === ChannelType.GuildText)
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ success: true, channels });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── Get Roles ────────────────────────────────────────────────────────────────
app.get('/api/roles/:guildId', async (req, res) => {
  if (!botClient) return res.status(400).json({ success: false, error: 'Bot not connected.' });
  try {
    const guild = await botClient.guilds.fetch(req.params.guildId);
    await guild.roles.fetch();
    const roles = guild.roles.cache
      .filter((r) => r.id !== guild.id && !r.managed) // exclude @everyone and bot roles
      .map((r) => ({ id: r.id, name: r.name, color: r.hexColor === '#000000' ? '#99aab5' : r.hexColor }))
      .sort((a, b) => b.position - a.position); // highest role first
    res.json({ success: true, roles });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── Post Ticket Panel ────────────────────────────────────────────────────────
app.post('/api/post-panel', async (req, res) => {
  if (!botClient) return res.status(400).json({ success: false, error: 'Bot not connected.' });

  const { channelId, guildId, imageUrl, embedColor, options, staffRoles } = req.body;
  if (!channelId) return res.status(400).json({ success: false, error: 'Channel ID is required.' });

  // Save config for this guild so ticket creation can use it
  if (guildId) {
    guildConfigs[guildId] = { staffRoles: staffRoles || [], embedColor };
  }

  try {
    const channel = await botClient.channels.fetch(channelId);
    if (!channel) return res.status(400).json({ success: false, error: 'Channel not found.' });

    const colorInt = parseInt((embedColor || '#00b4ff').replace('#', ''), 16);

    const embed = new EmbedBuilder()
      .setColor(colorInt)
      .setTitle('🌊 Ocean Scrims  |  Support Center')
      .setDescription(
        '**Welcome to Ocean Scrims!**\n\n' +
        'Need help from our team? Click one of the buttons below to open a private support ticket.\n' +
        'A staff member will respond as soon as possible.\n\n' +
        '> ⏱️  Average response time: **< 2 hours**\n' +
        '> 🔒  Tickets are **private** — only you & staff can see them\n' +
        '> ✏️   Be as detailed as possible when describing your issue'
      )
      .addFields(
        { name: '🎫 General Support',    value: 'Account issues, general questions, or anything else', inline: true },
        { name: '🎮 Scrim Requests',     value: 'Schedule scrims, team matchups & competitive play',   inline: true },
        { name: '⚖️  Reports & Appeals', value: 'Report rule-breakers or appeal your punishments',     inline: true },
        { name: '📌 How It Works',
          value: '**1.** Click the button matching your issue below\n**2.** A private channel will be created for you\n**3.** Describe your situation and wait for staff',
          inline: false },
      )
      .setFooter({ text: 'Ocean Scrims  •  Do not abuse the ticket system  •  False tickets may result in a ban', iconURL: botClient.user.displayAvatarURL() })
      .setTimestamp();

    if (imageUrl) {
      let finalUrl = imageUrl.trim();
      if (/^\d+$/.test(finalUrl)) finalUrl = `https://cdn.discordapp.com/emojis/${finalUrl}.png`;
      embed.setImage(finalUrl);
    }

    const buttons = [];
    if (options?.general !== false) buttons.push(new ButtonBuilder().setCustomId('os_ticket_general').setLabel('🎫  Open Ticket').setStyle(ButtonStyle.Primary));
    if (options?.scrim   !== false) buttons.push(new ButtonBuilder().setCustomId('os_ticket_scrim').setLabel('🎮  Scrim Request').setStyle(ButtonStyle.Success));
    if (options?.report  !== false) buttons.push(new ButtonBuilder().setCustomId('os_ticket_report').setLabel('⚖️  Report / Appeal').setStyle(ButtonStyle.Danger));
    if (options?.partner === true ) buttons.push(new ButtonBuilder().setCustomId('os_ticket_partner').setLabel('🤝  Partnership').setStyle(ButtonStyle.Secondary));

    const components = buttons.length ? [new ActionRowBuilder().addComponents(...buttons)] : [];
    await channel.send({ embeds: [embed], components });

    res.json({ success: true });
  } catch (err) {
    console.error('[Post Panel Error]', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

// ─── Status ───────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ connected: !!botClient, username: botClient?.user?.tag ?? null });
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(9500, () => {
  console.log('\n  🌊  Ocean Scrims Ticket Manager');
  console.log('  ────────────────────────────────');
  console.log('  ✅  Running at http://localhost:9500\n');
});
app.get("/", (req, res) => {
  res.send("Server is working");
});
