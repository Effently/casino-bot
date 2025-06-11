import {
  Client, GatewayIntentBits, Partials, Events, REST, Routes,
  SlashCommandBuilder, Interaction, EmbedBuilder, Message, MessageFlags, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ComponentType, CacheType
} from 'discord.js';
import { config } from 'dotenv';
import {
  initDB, getPoints, addPoints, getLastDaily,
  setLastDaily, getTopUsers, ensureUserExists
} from './db';

config();

const MIN_BET = 200;
const MIN_TRANSFER = 200;

const POINT_INTERVAL = 60 * 1000; // 1 min
const ENTRY_TTL = 60 * 60 * 1000; // 1 hour

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User]
});

const commands = [
  new SlashCommandBuilder().setName('balance').setDescription('Показать количество очков'),
  new SlashCommandBuilder().setName('casino').setDescription('Классическое казино')
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true)),
  new SlashCommandBuilder().setName('jackpot').setDescription('Азартный режим')
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Показать топ игроков'),
  new SlashCommandBuilder().setName('daily').setDescription('Получить ежедневный бонус'),
  new SlashCommandBuilder().setName('roulette').setDescription('Рулетка: выбери цвет и ставь')
    .addStringOption(opt => opt.setName('color').setDescription('Цвет').setRequired(true)
      .addChoices(
        { name: 'Красный', value: 'red' },
        { name: 'Чёрный', value: 'black' },
        { name: 'Зелёный', value: 'green' }))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true)),
  new SlashCommandBuilder().setName('dice').setDescription('Бросить кости')
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true)),
  new SlashCommandBuilder().setName('pay').setDescription('Передать очки другому участнику')
    .addUserOption(opt => opt.setName('user').setDescription('Кому').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Сколько').setRequired(true))
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN!);
  const appId = client.application?.id;
  if (!appId) throw new Error('Не удалось получить application.id');
  await rest.put(
    Routes.applicationCommands(appId),
    { body: commands }
  );
}

const voiceJoinTimestamps = new Map();

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  await initDB();
  await registerCommands();

  // register all vc members
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.isVoiceBased()) {
        for (const member of channel.members.values()) {
          // Добавляем с отметкой "сейчас"
          voiceJoinTimestamps.set(member.id, { joinedAt: Date.now() });
        }
      }
    }
  }

  //update saved vc members
  setInterval(async () => {
    const now = Date.now();

    for (const [userId, data] of voiceJoinTimestamps.entries()) {
      const { joinedAt } = data;
      await ensureUserExists(userId);

      if (now - joinedAt >= POINT_INTERVAL) {
        addPoints(userId, 10);

        voiceJoinTimestamps.set(userId, { joinedAt: now });
      }

      //clear laggy members
      if (now - joinedAt >= ENTRY_TTL) {
        voiceJoinTimestamps.delete(userId);
      }
    }
  }, POINT_INTERVAL);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const userId = newState.id;

  if (!voiceJoinTimestamps.has(userId) && newState.channelId) { // join
    voiceJoinTimestamps.set(userId, { joinedAt: Date.now() });
  }
  else if (!newState.channelId) { // leave
    voiceJoinTimestamps.delete(userId);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  await ensureUserExists(message.author.id);
  if (Math.random() < 0.5) {
    const pts = Math.floor(Math.random() * 5) + 1;
    await addPoints(message.author.id, pts);
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot || !reaction.message.author || reaction.message.author.id === user.id) return;
  await ensureUserExists(reaction.message.author.id);
  await addPoints(reaction.message.author.id, 1);
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {

    await interaction.deferReply();

    const userId = interaction.user.id;
    await ensureUserExists(userId);

    switch (interaction.commandName) {

      case 'balance': {
        const points = await getPoints(userId);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('⛃ Баланс')
              .setDescription(`У тебя ${points} очков`)
              .setColor('Blue')
          ]
        });
        break;
      }

      case 'daily': {
        const last = await getLastDaily(userId);
        const now = Date.now();

        if (last && now - last < 86400000) {
          const left = 86400000 - (now - last);
          const hours = Math.floor(left / 3600000);
          const minutes = Math.floor((left % 3600000) / 60000);

          await interaction.deleteReply();
          await interaction.followUp({ content: `Уже получал. Жди ${hours}ч ${minutes}м`, flags: MessageFlags.Ephemeral });
          return;
        }

        const bonus = 100 + Math.floor(Math.random() * 50);
        await addPoints(userId, bonus);
        await setLastDaily(userId, now);

        await interaction.editReply({ embeds: [
            new EmbedBuilder().setTitle('🎁 Ежедневный бонус').setDescription(`+${bonus} очков! ✨`).setColor('Green')
          ] });

        break;
      }

      case 'leaderboard': {
        const top = await getTopUsers(100);
        let page = 0;

        const getEmbed = (p: number) => {
          const embed = new EmbedBuilder().setTitle('⛩ Топ игроков').setColor('Gold');
          top.slice(p * 10, p * 10 + 10).forEach((u, i) =>
            embed.addFields({
              name: `${p * 10 + i + 1}.`,
              value: `<@${u.id}> — ${u.points} очков`
            })
          );
          return embed;
        };

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('prev').setLabel('◀').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('next').setLabel('▶').setStyle(ButtonStyle.Secondary)
        );

        //await interaction.editReply({ embeds: [getEmbed(page)], components: [row] });
        //const msg = await interaction.fetchReply() as Message;

        const msg = await interaction.editReply({ embeds: [getEmbed(page)], components: [row] });
        const collector = (msg as Message).createMessageComponentCollector({ componentType: ComponentType.Button, time: 60000 });

        collector.on('collect', async btn => {
          if (btn.user.id !== userId)
            return btn.reply({ content: 'Кнопка только для участника, вызвавшего список.', flags: MessageFlags.Ephemeral });

          if (btn.customId === 'next' && (page + 1) * 10 < top.length) page++;
          else if (btn.customId === 'prev' && page > 0) page--;

          await btn.update({ embeds: [getEmbed(page)] });
        });
        break;
      }

      case 'pay': {
        const target = interaction.options.getUser('user', true);
        const amount = interaction.options.getInteger('amount', true);

        if (target.bot || target.id === userId) {
          await interaction.deleteReply();
          await interaction.followUp({ content: `Недопустимая операция.`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (amount < MIN_TRANSFER) {
          await interaction.deleteReply();
          await interaction.followUp({ content: `Минимальная сумма перевода: ${MIN_TRANSFER} очков`, flags: MessageFlags.Ephemeral });
          return;
        }
        const balance = await getPoints(userId);
        if (balance < amount) {
          await interaction.deleteReply();
          await interaction.followUp({ content: `Недостаточно очков: ${amount - balance} очков не хватает.`, flags: MessageFlags.Ephemeral });
          return;
        }

        await ensureUserExists(target.id);
        await addPoints(userId, -amount);
        await addPoints(target.id, amount);

        const jokes = [
          `💸 <@${userId}> перевёл ${amount} очков <@${target.id}> — «на дошик!»`,
          `🎁 Подарок! <@${userId}> отправил ${amount} очков <@${target.id}>`,
          `😎 <@${userId}> делает инвестиции в <@${target.id}> (${amount} очков)`
        ];
        const response = jokes[Math.floor(Math.random() * jokes.length)];

        await interaction.editReply({ content: response });
        break;
      }

      case 'casino': {
        const bet = interaction.options.getInteger('amount', true);
        const balance = await getPoints(userId);

        if (bet < MIN_BET || balance < bet) {
          await interaction.deleteReply();
          await interaction.followUp({ content: 'Минимальная ставка 500 очков.', ephemeral: true });
          return;
        }

        const slots = ['🍒', '🍋', '🔔', '💎', '7️⃣'];
        const result = Array.from({ length: 3 }, () => slots[Math.floor(Math.random() * slots.length)]);
        const win = result.every(s => s === result[0]) ? bet * 5 : 0;
        await addPoints(userId, win - bet);

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🎰 Казино')
              .setDescription(`| ${result.join(' | ')} |
          ${win > 0 ? `🎉 Победа: ${win} очков!` : `❌ Проигрыш: ${bet} очков.`}`)
              .setColor(win > 0 ? 'Green' : 'Red')
          ]
        });
        break;
      }

      case 'jackpot': {
        const bet = interaction.options.getInteger('amount', true);
        const balance = await getPoints(userId);

        if (bet < MIN_BET) {
          await interaction.deleteReply();
          await interaction.followUp({ content: `Минимальная ставка: ${MIN_BET} очков`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (balance < bet) {
          await interaction.deleteReply();
          await interaction.followUp({ content: `Недостаточно очков: ${bet - balance} очков не хватает.`, flags: MessageFlags.Ephemeral });
          return;
        }

        const chances = [
          { multiplier: 0, chance: 0.4 },
          { multiplier: 0.5, chance: 0.25 },
          { multiplier: 1, chance: 0.2 },
          { multiplier: 2, chance: 0.1 },
          { multiplier: 5, chance: 0.04 },
          { multiplier: 10, chance: 0.01 }
        ];

        let roll = Math.random(), acc = 0, multiplier = 0;
        for (const c of chances) {
          acc += c.chance;
          if (roll <= acc) { multiplier = c.multiplier; break; }
        }

        const win = Math.floor(bet * multiplier);
        await addPoints(userId, win - bet);

        const result =
          win > bet
            ? `🎉 Выигрыш: ${win - bet} очков!`
            : win === bet
            ? 'Ничья, ставка возвращена.'
            : `Проигрыш: ${bet - win} очков.`;
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('⚡ Jackpot')
              .setDescription(`Ставка: ${bet}\nМножитель: ${multiplier}x\n${result}`)
              .setColor(win > bet ? 'Green' : win === bet ? 'Yellow' : 'Red')
          ]
        });
        break;
      }

      case 'roulette': {
        const bet = interaction.options.getInteger('amount', true);
        const color = interaction.options.getString('color', true);

        const balance = await getPoints(userId);

        if (bet < MIN_BET) {
          await interaction.deleteReply();
          await interaction.followUp({ content: `Минимальная ставка — ${MIN_BET} очков.`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (balance < bet) {
          await interaction.deleteReply();
          await interaction.followUp({ content: `Недостаточно очков для ставки: ${bet - balance} очков не хватает.`, flags: MessageFlags.Ephemeral });
          return;
        }

        const wheel = Math.random();
        let resultColor = 'black';
        if (wheel < 0.027) resultColor = 'green';
        else if (wheel < 0.5135) resultColor = 'red';

        const multiplier = color === resultColor ? (color === 'green' ? 14 : 2) : 0;
        const win = Math.floor(bet * multiplier);
        await addPoints(userId, win - bet);

        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🎡 Рулетка')
              .setDescription(`🎯 Выпало: ${resultColor}
    🎨 Ты выбрал: ${color}
    ${multiplier > 0 ? `✅ Победа: ${win} очков!` : `❌ Проигрыш: ${bet} очков.`}`)
              .setColor(multiplier > 0 ? 'Green' : 'Red')
          ]
        });
        break;
      }

      case 'dice': {
        const bet = interaction.options.getInteger('amount', true);
        const balance = await getPoints(userId);

        if (bet < MIN_BET) {
          await interaction.deleteReply();
          await interaction.followUp({ content: `Минимальная ставка — ${MIN_BET} очков.`, flags: MessageFlags.Ephemeral });
          return;
        }
        if (balance < bet) {
          await interaction.deleteReply();
          await interaction.followUp({ content: `Недостаточно очков для ставки: ${bet - balance} очков не хватает`, flags: MessageFlags.Ephemeral });
          return;
        }

        const roll1 = Math.floor(Math.random() * 6) + 1;
        const roll2 = Math.floor(Math.random() * 6) + 1;
        const sum = roll1 + roll2;
        const multiplier = sum > 7 ? 2 : sum === 7 ? 1 : 0;
        const win = bet * multiplier;

        await addPoints(userId, win - bet);
        await interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🎲 Кости')
              .setDescription(`Бросок: ${roll1} и ${roll2} (сумма ${sum})
              ${multiplier ? `✅ Выигрыш: ${win - bet} очков` : `❌ Проигрыш: ${bet} очков.`}`)
              .setColor(multiplier ? 'Green' : 'Red')
          ]
        });
        break;
      }
    }

  } catch (error) {
    console.error("Ошибка в обработчике команд:", error);
    // if (interaction.deferred || interaction.replied) {
    //   await interaction.editReply("⚠️ Произошла ошибка при выполнении команды, попробуйте снова...");
    // } else {
    //   await interaction.reply({ content: "⚠️ Произошла ошибка при выполнении команды, попробуйте снова...", flags: MessageFlags.Ephemeral });
    // }
  }
});

client.login(process.env.BOT_TOKEN);
