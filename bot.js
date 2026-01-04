#!/usr/bin/env node

// Solvan - Solana Vanity Address Generator - Telegram Bot
// WITH MIDDLEWARE LOGGING FOR DEBUGGING

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { Queue, Worker, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import { Telegraf, session } from 'telegraf';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve('.env');

// Load environment
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split('\n').forEach(line => {
    const [key, ...valueParts] = line.trim().split('=');
    if (key && valueParts.length) {
      process.env[key.trim()] = valueParts.join('=').trim();
    }
  });
}

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ TELEGRAM_BOT_TOKEN not found!');
  process.exit(1);
}
console.log('✅ Bot token loaded');

// Initialize Redis
const redis = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379,
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 50, 2000),
});

const redisForResults = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379,
});

redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('❌ Redis error:', err));

// Queue
const vanityQueue = new Queue('vanity-generation', {
  connection: redis,
  defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
});

// Queue Events
const queueEvents = new QueueEvents('vanity-generation', { connection: redis });

// Worker
const worker = new Worker('vanity-generation', async (job) => {
  const { searchType, vanityString, caseSensitive } = job.data;

  console.log(`Processing job ${job.id}: ${searchType} ${vanityString}`);

  return new Promise((resolve, reject) => {
    const python = spawn(
      'python3',
      [
        '-u',
        'vanity_generator.py',
        '--search-type', searchType,
        '--vanity-string', vanityString,
        '--case-sensitive', caseSensitive ? 'true' : 'false',
        '--num-wallets', '1',
      ],
      { cwd: '/app', stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let output = '';
    let errorOutput = '';

    python.stdout.on('data', (data) => {
      output += data.toString();
    });

    python.stderr.on('data', (data) => {
      errorOutput += data.toString();
      console.log(`Job ${job.id} Stderr: ${data.toString()}`);
    });

    python.on('close', (code) => {
      console.log(`Job ${job.id} Process exited with code ${code}`);

      if (code !== 0) {
        console.error(`Job ${job.id} Generator failed: ${errorOutput}`);
        reject(new Error(`Generator error: ${errorOutput}`));
        return;
      }

      try {
        if (!output || output.trim().length === 0) {
          reject(new Error('Generator produced no output'));
          return;
        }

        const result = JSON.parse(output);
        console.log(`Job ${job.id} Storing result in Redis...`);

        redisForResults
          .setex(`vanity-result:${job.id}`, 3600, JSON.stringify(result))
          .then(() => {
            console.log(`Job ${job.id} Result stored`);
            resolve({ success: true, jobId: job.id });
          })
          .catch((err) => {
            console.error(`Job ${job.id} Redis error: ${err.message}`);
            reject(err);
          });
      } catch (e) {
        console.error(`Job ${job.id} Parse error: ${e.message}`);
        reject(e);
      }
    });

    python.on('error', (err) => {
      console.error(`Job ${job.id} Process error: ${err.message}`);
      reject(err);
    });

    setTimeout(() => {
      console.log(`Job ${job.id} Timeout reached`);
      python.kill('SIGKILL');
      reject(new Error('Timeout'));
    }, 600000); // 10 minutes timeout
  });
}, { connection: redis, concurrency: 4 });

worker.on('completed', (job) => {
  console.log(`✅ Job ${job.id} completed`);
});

worker.on('failed', (job, err) => {
  console.log(`❌ Job ${job.id} failed: ${err.message}`);
});

// Stats
const statsFile = path.join(__dirname, 'vanity_addresses.jsonl');

function logStatistic(userId, data) {
  const entry = { timestamp: new Date().toISOString(), userId, ...data };
  fs.appendFileSync(statsFile, JSON.stringify(entry) + '\n');
}

function getStats(userId) {
  if (!fs.existsSync(statsFile)) return { count: 0, total: 0 };

  const lines = fs.readFileSync(statsFile, 'utf-8').split('\n').filter(l => l);
  const userLines = lines.filter((l) => {
    try {
      return JSON.parse(l).userId === userId;
    } catch {
      return false;
    }
  });

  return { count: userLines.length, total: lines.length };
}

async function getQueueSize() {
  const waiting = await vanityQueue.getWaitingCount();
  const active = await vanityQueue.getActiveCount();
  return { waiting, active, total: waiting + active };
}

async function waitForJobCompletion(jobId, maxWaitMs = 3600000) {
  const startTime = Date.now();

  try {
    const job = await vanityQueue.getJob(jobId);
    if (!job) throw new Error('Job not found in queue');

    console.log(`Job ${jobId} Waiting for job to finish (max ${maxWaitMs / 1000}s)...`);

    await Promise.race([
      job.waitUntilFinished(queueEvents),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Job timeout')), maxWaitMs)
      ),
    ]);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`Job ${jobId} Job finished after ${elapsed}s`);

    const resultJson = await redisForResults.get(`vanity-result:${jobId}`);
    if (!resultJson) throw new Error('Result not in Redis - job may have failed');

    return JSON.parse(resultJson);
  } catch (error) {
    console.error(`Job ${jobId} Wait failed: ${error.message}`);
    throw error;
  }
}

async function handleGeneration(
  queue,
  events,
  redis,
  chatId,
  messageId,
  searchType,
  vanityString,
  caseSensitive,
  userId,
  ctx,
  userJobs
) {
  let jobId = null;
  try {
    const job = await queue.add('vanity-generation', {
      searchType,
      vanityString,
      caseSensitive,
      userId,
      chatId,
    });

    jobId = job.id;
    userJobs.set(userId, jobId);

    console.log(`Job ${job.id} created for user ${userId}`);

    const result = await waitForJobCompletion(job.id);

    if (!result || !result.address) throw new Error('Invalid result');

    logStatistic(userId, {
      searchType,
      vanityString,
      caseSensitive,
      address: result.address,
      attempts: result.attempts,
      timeMs: result.time * 1000,
    });

    const telegram = ctx.telegram;

    await telegram.deleteMessage(chatId, messageId).catch(() => {});

    await telegram.sendMessage(
      chatId,
      `<b>🔑 Wallet Details</b>

<b>Public Address</b>
<code>${result.address}</code>

<b>Private Key</b>
<code>${result.privateKeyBase58}</code>

<b>Import to Phantom</b>
1. Click "Add Account"
2. Choose "Import Private Key"
3. Paste private key above

<i>🔐 Keep this secret!</i>

Want another?`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🔄 Generate Again', callback_data: 'start_gen' }]],
        },
      }
    );
  } catch (error) {
    console.error(`User ${userId} Generation error: ${error.message}`);

    await ctx.telegram
      .editMessageText(
        chatId,
        messageId,
        null,
        `<b>❌ Generation ${error.message === 'Cancelled' ? 'cancelled' : 'failed'}</b>

${error.message === 'Cancelled' ? 'Your wallet generation has been cancelled.' : `<code>${error.message}</code>`}

Try /generate again`,
        { parse_mode: 'HTML' }
      )
      .catch(() => {});
  } finally {
    userJobs.delete(userId);
  }
}

// Telegram Bot
const bot = new Telegraf(BOT_TOKEN);

const sessions = new Map();

// ✅ Track users currently generating
const generatingUsers = new Set();

// ✅ Track jobId for each user (for cancellation)
const userJobs = new Map();

bot.use(
  session({
    defaultSession: () => ({}),
    property: 'session',
    getSessionKey: (ctx) => {
      if (ctx.from?.id) {
        const key = `user-${ctx.from.id}`;
        if (!sessions.has(key)) {
          sessions.set(key, {});
        }
        return key;
      }
      return null;
    },
    store: {
      get: (key) => sessions.get(key) || {},
      set: (key, val) => sessions.set(key, val),
      delete: (key) => sessions.delete(key),
    },
  })
);

// LOGGING MIDDLEWARE - LOGS EVERY UPDATE
bot.use((ctx, next) => {
  const timestamp = new Date().toISOString();
  const userId = ctx.from?.id || 'unknown';
  const text = ctx.message?.text || ctx.callbackQuery?.data || 'no-text';
  console.log(`[${timestamp}] USER ${userId}: ${text}`);
  return next();
});

bot.command('start', async (ctx) => {
  try {
    console.log(`[START] User ${ctx.from.id}`);
    const stats = getStats(ctx.from.id);
    const queueSize = await getQueueSize();

    await ctx.replyWithHTML(
      `<b>🔑 Solana Vanity Address Generator</b>

Premium custom address generation service!

<b>Queue Status</b>
🟢 Active: ${queueSize.active}
⏳ Waiting: ${queueSize.waiting}

<b>Your Stats</b>
📊 Generated: ${stats.count}
📈 Total: ${stats.total}

<b>Commands</b>
/generate - Start generation
/info - How it works
/stats - View stats
/about - About this bot`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '🚀 Generate Now', callback_data: 'start_gen' }]],
        },
      }
    );
  } catch (err) {
    console.error('Start command error:', err);
  }
});

bot.command('generate', async (ctx) => {
  try {
    console.log(`[GENERATE] User ${ctx.from.id}`);
    const userId = ctx.from.id;

    // ✅ Check if user already generating
    if (generatingUsers.has(userId)) {
      await ctx.replyWithHTML(
        `⚠️ <b>You already have a generation in progress!</b>

Please wait for your current wallet to finish generating before starting a new one.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const queueSize = await getQueueSize();

    await ctx.replyWithHTML(
      `<b>🎯 Vanity Address Generation</b>

Queue: ${queueSize.active} active, ${queueSize.waiting} waiting

What do you want to find?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📍 Prefix', callback_data: 'type_prefix' },
              { text: '🔚 Suffix', callback_data: 'type_suffix' },
            ],
          ],
        },
      }
    );
  } catch (err) {
    console.error('Generate command error:', err);
  }
});

bot.command('info', async (ctx) => {
  try {
    console.log(`[INFO] User ${ctx.from.id} - sending info...`);

    await ctx.replyWithHTML(
      `<b>How Vanity Addresses Work</b>

A custom address starting/ending with your chosen text.

<b>⏱️ Generation Time Estimate</b>

<pre>String Length │ Insensitive │ Sensitive
─────────────┼─────────────┼──────────
1 char       │ 1 sec       │ 1-2 sec
2 chars      │ 1-5 sec     │ 5-30 sec
3 chars      │ 10-60 sec   │ 1-5 min
4 chars      │ 2-10 min    │ 10-60 min</pre>

<b>💡 Tips</b>
📍 <b>Prefix search</b> is case-insensitive by default
🔚 <b>Suffix search</b> works with both cases
🔤 <b>Case-sensitive</b> takes longer but matches exact casing

<b>🔐 Security</b>
✅ 100% generated locally
✅ Never logged
✅ Safe to use immediately`,
      { parse_mode: 'HTML' }
    );

    console.log(`[INFO] User ${ctx.from.id} - info sent!`);
  } catch (err) {
    console.error('[INFO] ERROR:', err.message, err);
  }
});

bot.command('stats', async (ctx) => {
  try {
    console.log(`[STATS] User ${ctx.from.id} - sending stats...`);
    const stats = getStats(ctx.from.id);
    const queueSize = await getQueueSize();

    await ctx.replyWithHTML(
      `<b> Your Statistics</b>

Addresses generated: <code>${stats.count}</code>
Total orders: <code>${stats.total}</code>

<b>System Status</b>
Active generations: ${queueSize.active}
Queued: ${queueSize.waiting}

/generate to create more!`,
      { parse_mode: 'HTML' }
    );

    console.log(`[STATS] User ${ctx.from.id} - stats sent!`);
  } catch (err) {
    console.error('[STATS] ERROR:', err.message, err);
  }
});

// ✅ NEW: Admin command to clear queue
bot.command('clearqueue', async (ctx) => {
  try {
    const adminIds = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));
    
    if (!adminIds.includes(ctx.from.id)) {
      await ctx.replyWithHTML(
        `❌ <b>Unauthorized</b>

You don't have permission to use this command.`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    console.log(`[CLEARQUEUE] Admin ${ctx.from.id} clearing queue...`);

    // Clear all jobs from the queue
    await vanityQueue.obliterate({ force: true });
    
    // Clear the generating users set
    generatingUsers.clear();
    userJobs.clear();

    await ctx.replyWithHTML(
      `✅ <b>Queue Cleared!</b>

All jobs have been removed from the queue.
All users cleared from generation set.`,
      { parse_mode: 'HTML' }
    );

    console.log(`[CLEARQUEUE] Queue cleared successfully!`);
  } catch (err) {
    console.error('Clear queue error:', err);
    await ctx.replyWithHTML(
      `❌ <b>Error clearing queue</b>

<code>${err.message}</code>`,
      { parse_mode: 'HTML' }
    );
  }
});

bot.command('about', async (ctx) => {
  try {
    console.log(`[ABOUT] User ${ctx.from.id} - sending about...`);

    await ctx.replyWithHTML(
      `<b> About Solvan</b>

<b>Solana Vanity Address Generator</b>

Open source project for generating custom Solana addresses

<b>Build Your Own Bot</b>
<code>https://github.com/whale-professor/Solvan</code>

<b>Features</b>
✨ Prefix & Suffix generation
🔐 100% local, secure generation
📊 Statistics tracking
⚡ Fast queue-based processing

<b>Contact & Support</b>
Telegram: @WhaleProfessor
GitHub Issues: Report bugs

Built with ❤️ for the Solana community`,
      { parse_mode: 'HTML' }
    );

    console.log(`[ABOUT] User ${ctx.from.id} - about sent!`);
  } catch (err) {
    console.error('[ABOUT] ERROR:', err.message, err);
  }
});

bot.action('type_prefix', async (ctx) => {
  try {
    await ctx.answerCbQuery();

    ctx.session.searchType = 'prefix';
    const type = 'Prefix';

    await ctx.replyWithHTML(
      `<b>${type} Mode</b>

Enter your desired ${type.toLowerCase()} (1-4 chars)

<i>Example: SOL, STAR, 123</i>`,
      {
        reply_markup: { force_reply: true },
        input_field_placeholder: `Enter ${type.toLowerCase()}`,
      }
    );
  } catch (err) {
    console.error('Type prefix error:', err);
  }
});

bot.action('type_suffix', async (ctx) => {
  try {
    await ctx.answerCbQuery();

    ctx.session.searchType = 'suffix';
    const type = 'Suffix';

    await ctx.replyWithHTML(
      `<b>${type} Mode</b>

Enter your desired ${type.toLowerCase()} (1-4 chars)

<i>Example: SOL, STAR, 123</i>`,
      {
        reply_markup: { force_reply: true },
        input_field_placeholder: `Enter ${type.toLowerCase()}`,
      }
    );
  } catch (err) {
    console.error('Type suffix error:', err);
  }
});

bot.on('text', async (ctx) => {
  try {
    if (!ctx.session?.searchType) return;

    const vanityString = ctx.message.text.trim();

    if (vanityString.length < 1 || vanityString.length > 4) {
      await ctx.replyWithHTML(
        `Invalid length! Must be 1-4 characters.
        
Entered: <code>${vanityString}</code> (${vanityString.length} chars)`,
        { reply_markup: { force_reply: true } }
      );
      return;
    }

    const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    if (!vanityString.split('').every((c) => BASE58_CHARS.includes(c))) {
      await ctx.replyWithHTML(
        `❌ Invalid Base58 character!

<b>Cannot use:</b>
0 (zero), O (capital), I (capital), l (lowercase L)

<b>Can use:</b>
lowercase i, uppercase L, all numbers except 0, all other letters`,
        { reply_markup: { force_reply: true } }
      );
      return;
    }

    ctx.session.vanityString = vanityString;

    await ctx.replyWithHTML(
      `<b>Case Sensitivity</b>

<code>${vanityString}</code> vs <code>${vanityString.toLowerCase()}</code>?

Should search be case-sensitive?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔤 Sensitive', callback_data: 'case_yes' },
              { text: '🔡 Insensitive (faster)', callback_data: 'case_no' },
            ],
          ],
        },
      }
    );
  } catch (err) {
    console.error('Text handler error:', err);
  }
});

// ✅ FIXED: Delete buttons after click + Check if user is already generating
bot.action(['case_yes', 'case_no'], async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const userId = ctx.from.id;

    // ✅ Prevent simultaneous generation
    if (generatingUsers.has(userId)) {
      await ctx.answerCbQuery('⚠️ You already have a generation in progress!', true);
      return;
    }

    const caseSensitive = ctx.match[0] === 'case_yes';
    const searchType = ctx.session.searchType;
    const vanityString = ctx.session.vanityString;
    const chatId = ctx.chat.id;

    const queueSize = await getQueueSize();

    const waitMsg = await ctx.replyWithHTML(
      `⏳ <b>Queued for generation!</b>

Type: <code>${searchType}</code>
Search: <code>${vanityString}</code>
Case: ${caseSensitive ? '🔤 Sensitive' : '🔡 Insensitive'}

📊 Queue position: #${queueSize.waiting + 1}
⚙️ ${queueSize.active} generation(s) in progress...`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'cancel_gen' }]],
        },
      }
    );

    // ✅ Mark user as generating
    generatingUsers.add(userId);

    // ✅ Delete the case sensitivity buttons after user clicks
    await ctx.deleteMessage(ctx.callbackQuery.message.message_id).catch(() => {});

    ctx.session = {};

    handleGeneration(
      vanityQueue,
      queueEvents,
      redisForResults,
      chatId,
      waitMsg.message_id,
      searchType,
      vanityString,
      caseSensitive,
      userId,
      ctx,
      userJobs
    )
      .catch((err) => console.error(`[User ${userId}] Unhandled: ${err.message}`))
      .finally(() => {
        // ✅ Remove user from generating set when done
        generatingUsers.delete(userId);
      });
  } catch (err) {
    console.error('Case sensitivity handler error:', err);
  }
});

// ✅ NEW: Cancel generation
bot.action('cancel_gen', async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const userId = ctx.from.id;
    const jobId = userJobs.get(userId);

    if (!jobId) {
      await ctx.answerCbQuery('❌ No active generation found!', true);
      return;
    }

    console.log(`[CANCEL] User ${userId} cancelling job ${jobId}`);

    try {
      const job = await vanityQueue.getJob(jobId);
      if (job) {
        await job.remove();
        console.log(`[CANCEL] Job ${jobId} removed from queue`);
      }
    } catch (err) {
      console.error(`[CANCEL] Error removing job: ${err.message}`);
    }

    // Mark as cancelled for the handler to catch
    userJobs.delete(userId);
    generatingUsers.delete(userId);

    await ctx.editMessageText(
      `<b>⚠️ Generation Cancelled</b>

Your wallet generation has been stopped.

Start a new one with /generate`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🚀 Generate Again', callback_data: 'start_gen' }]],
        },
      }
    );

    console.log(`[CANCEL] User ${userId} generation cancelled successfully`);
  } catch (err) {
    console.error('Cancel generation error:', err);
  }
});

bot.action(['start_gen'], async (ctx) => {
  try {
    await ctx.answerCbQuery();

    const userId = ctx.from.id;

    // ✅ Check if user already generating
    if (generatingUsers.has(userId)) {
      await ctx.answerCbQuery('⚠️ You already have a generation in progress!', true);
      return;
    }

    await ctx.replyWithHTML(`<b>🎯 Vanity Address Generation</b>

What do you want to find?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '📍 Prefix', callback_data: 'type_prefix' },
              { text: '🔚 Suffix', callback_data: 'type_suffix' },
            ],
          ],
        },
      }
    );
  } catch (err) {
    console.error('Start gen action error:', err);
  }
});

bot.catch((err, ctx) => {
  console.error('Bot error:', err);

  ctx.replyWithHTML(`Error: <code>${err.message}</code>`).catch(() => {});
});

console.log('\n🚀 Solvan Bot starting...');

bot.launch({
  allowedUpdates: ['message', 'callback_query'],
});

console.log('✅ Bot is POLLING - waiting for messages...');
console.log('✅ Commands: /start, /generate, /info, /stats, /about, /clearqueue\n');

process.once('SIGINT', async () => {
  console.log('\n👋 Shutting down...');
  await worker.close();
  await queueEvents.close();
  await redisForResults.quit();
  bot.stop('SIGINT');
});

process.once('SIGTERM', async () => {
  console.log('\n👋 Shutting down...');
  await worker.close();
  await queueEvents.close();
  await redisForResults.quit();
  bot.stop('SIGTERM');
});
