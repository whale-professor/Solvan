#!/usr/bin/env node

/**
 * Solana Vanity Address Generator - Telegram Bot
 * WITH MIDDLEWARE LOGGING FOR DEBUGGING
 */

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
  retryStrategy: (times) => Math.min(times * 50, 2000)
});

const redisForResults = new Redis({
  host: process.env.REDIS_HOST || 'redis',
  port: process.env.REDIS_PORT || 6379
});

redis.on('connect', () => console.log('✅ Redis connected'));
redis.on('error', (err) => console.error('Redis error:', err));

// Queue
const vanityQueue = new Queue('vanity-generation', { 
  connection: redis,
  defaultJobOptions: {
    attempts: 1,
    removeOnComplete: true,
    removeOnFail: true
  }
});

// Queue Events
const queueEvents = new QueueEvents('vanity-generation', { connection: redis });

// Worker
const worker = new Worker('vanity-generation', 
  async (job) => {
    const { searchType, vanityString, caseSensitive } = job.data;
    
    console.log(`⚙️ Processing job ${job.id}: ${searchType} "${vanityString}"`);
    
    return new Promise((resolve, reject) => {
      const python = spawn('python3', [
        '-u',
        'vanity_generator.py',
        '--search-type', searchType,
        '--vanity-string', vanityString,
        '--case-sensitive', caseSensitive ? 'true' : 'false',
        '--num-wallets', '1'
      ], { 
        cwd: '/app',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let output = '';
      let errorOutput = '';
      
      python.stdout.on('data', (data) => {
        output += data.toString();
      });
      
      python.stderr.on('data', (data) => {
        errorOutput += data.toString();
        console.log(`[Job ${job.id}] Stderr:`, data.toString());
      });
      
      python.on('close', (code) => {
        console.log(`[Job ${job.id}] Process exited with code ${code}`);
        
        if (code !== 0) {
          console.error(`[Job ${job.id}] Generator failed: ${errorOutput}`);
          reject(new Error(`Generator error: ${errorOutput}`));
          return;
        }
        
        try {
          if (!output || output.trim().length === 0) {
            reject(new Error('Generator produced no output'));
            return;
          }
          
          const result = JSON.parse(output);
          console.log(`[Job ${job.id}] ✅ Storing result in Redis...`);
          
          redisForResults.setex(
            `vanity-result:${job.id}`,
            3600,
            JSON.stringify(result)
          ).then(() => {
            console.log(`[Job ${job.id}] ✅ Result stored`);
            resolve({ success: true, jobId: job.id });
          }).catch(err => {
            console.error(`[Job ${job.id}] Redis error: ${err.message}`);
            reject(err);
          });
        } catch (e) {
          console.error(`[Job ${job.id}] Parse error: ${e.message}`);
          reject(e);
        }
      });
      
      python.on('error', (err) => {
        console.error(`[Job ${job.id}] Process error: ${err.message}`);
        reject(err);
      });
      
      setTimeout(() => {
        console.log(`[Job ${job.id}] Timeout reached`);
        python.kill('SIGKILL');
        reject(new Error('Timeout'));
      }, 600000);
    });
  },
  { 
    connection: redis, 
    concurrency: 4
  }
);

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
  const userLines = lines.filter(l => {
    try { return JSON.parse(l).userId === userId; } catch { return false; }
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
    if (!job) {
      throw new Error('Job not found in queue');
    }

    console.log(`[Job ${jobId}] Waiting for job to finish (max ${maxWaitMs / 1000}s)...`);
    
    await Promise.race([
      job.waitUntilFinished(queueEvents),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Job timeout')), maxWaitMs)
      )
    ]);

    const elapsed = Math.round((Date.now() - startTime) / 1000);
    console.log(`[Job ${jobId}] ✅ Job finished after ${elapsed}s`);
    
    const resultJson = await redisForResults.get(`vanity-result:${jobId}`);
    if (!resultJson) {
      throw new Error('Result not in Redis - job may have failed');
    }
    
    return JSON.parse(resultJson);
    
  } catch (error) {
    console.error(`[Job ${jobId}] Wait failed: ${error.message}`);
    throw error;
  }
}

async function handleGeneration(queue, events, redis, chatId, messageId, searchType, vanityString, caseSensitive, userId, ctx) {
  try {
    const job = await queue.add('vanity-generation', {
      searchType, vanityString, caseSensitive, userId, chatId
    });
    
    console.log(`📋 Job ${job.id} created for user ${userId}`);
    
    const result = await waitForJobCompletion(job.id);
    
    if (!result || !result.address) {
      throw new Error('Invalid result');
    }
    
    logStatistic(userId, {
      searchType, vanityString, caseSensitive,
      address: result.address,
      attempts: result.attempts,
      timeMs: result.time * 1000
    });
    
    const telegram = ctx.telegram;
    
    await telegram.deleteMessage(chatId, messageId).catch(() => {});
    
    await telegram.sendMessage(
      chatId,
      `<b>🔐 Wallet Details</b>\n\n<b>Public Address:</b>\n<code>${result.address}</code>\n\n<b>Private Key:</b>\n<code>${result.privateKeyBase58}</code>\n\n<b>Import to Phantom:</b>\n1. Click "Add Account"\n2. Choose "Import Private Key"\n3. Paste private key above\n\n⚠️ <i>Keep this secret!</i>\n\n<b>Want another?</b>`,
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [[{ text: '🔄 Generate Again', callback_data: 'start_gen' }]]
        }
      }
    );
    
  } catch (error) {
    console.error(`[User ${userId}] Generation error: ${error.message}`);
    await ctx.telegram.editMessageText(
      chatId,
      messageId,
      `❌ <b>Generation failed</b>\n\nError: <code>${error.message}</code>\n\n💡 Try /generate again`,
      { parse_mode: 'HTML' }
    ).catch(() => {});
  }
}

// Telegram Bot
const bot = new Telegraf(BOT_TOKEN);

const sessions = new Map();
bot.use(session({
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
    delete: (key) => sessions.delete(key)
  }
}));

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
      `🔑 <b>Solana Vanity Address Generator</b>\n\n` +
      `Premium custom address generation service!\n\n` +
      `<b>Queue Status:</b>\n` +
      `⚙️ Active: ${queueSize.active}\n` +
      `⏳ Waiting: ${queueSize.waiting}\n\n` +
      `<b>Your Stats:</b>\n📊 Generated: ${stats.count}\n📈 Total: ${stats.total}\n\n` +
      `<b>Commands:</b>\n/generate - Start generation\n/info - How it works\n/stats - View stats`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: '🚀 Generate Now', callback_data: 'start_gen' }]]
        }
      }
    );
  } catch (err) {
    console.error('Start command error:', err);
  }
});

bot.command('generate', async (ctx) => {
  try {
    console.log(`[GENERATE] User ${ctx.from.id}`);
    const queueSize = await getQueueSize();
    
    await ctx.replyWithHTML(
      `<b>Vanity Address Generation</b>\n\n` +
      `📊 Queue: ${queueSize.active} active, ${queueSize.waiting} waiting\n\n` +
      `What do you want to find?`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '📍 Prefix', callback_data: 'type_prefix' },
            { text: '🔚 Suffix', callback_data: 'type_suffix' }
          ]]
        }
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
      `<b>How Vanity Addresses Work</b>\n\nA custom address starting/ending with your chosen text.\n\n` +
      `<b>Generation Time (approx):</b>\n` +
      `⚡ 1-char: 1 second\n⚡ 2-char: 1-5 seconds\n⚡ 3-char: 10-60 seconds\n` +
      `⚡ 4-char: 2-10 minutes\n\n` +
      `<b>Security:</b>\n🔒 100% generated locally\n🔒 Never logged\n🔒 Safe to use immediately`
    );
    console.log(`[INFO] User ${ctx.from.id} - info sent!`);
  } catch (err) {
    console.error(`[INFO ERROR] ${err.message}`, err);
  }
});

bot.command('stats', async (ctx) => {
  try {
    console.log(`[STATS] User ${ctx.from.id} - sending stats...`);
    const stats = getStats(ctx.from.id);
    const queueSize = await getQueueSize();
    
    await ctx.replyWithHTML(
      `<b>📊 Your Statistics</b>\n\n` +
      `👤 Addresses generated: ${stats.count}\n` +
      `💾 Total orders: ${stats.total}\n\n` +
      `<b>System Status:</b>\n` +
      `⚙️ Active generations: ${queueSize.active}\n` +
      `⏳ Queued: ${queueSize.waiting}\n\n` +
      `🚀 /generate to create more!`
    );
    console.log(`[STATS] User ${ctx.from.id} - stats sent!`);
  } catch (err) {
    console.error(`[STATS ERROR] ${err.message}`, err);
  }
});

bot.action('type_prefix', async (ctx) => {
  try {
    await ctx.answerCbQuery();
    ctx.session.searchType = 'prefix';
    const type = 'Prefix';
    await ctx.replyWithHTML(
      `<b>${type} Mode</b>\n\nEnter your desired ${type.toLowerCase()} (1-4 chars):\n\n<i>Example: SOL, STAR, 123</i>`,
      {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: `Enter ${type.toLowerCase()}`
        }
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
      `<b>${type} Mode</b>\n\nEnter your desired ${type.toLowerCase()} (1-4 chars):\n\n<i>Example: SOL, STAR, 123</i>`,
      {
        reply_markup: {
          force_reply: true,
          input_field_placeholder: `Enter ${type.toLowerCase()}`
        }
      }
    );
  } catch (err) {
    console.error('Type suffix error:', err);
  }
});

bot.on('text', async (ctx) => {
  try {
    if (!ctx.session?.searchType) {
      return;
    }
    
    const vanityString = ctx.message.text.trim();
    
    if (vanityString.length < 1 || vanityString.length > 4) {
      await ctx.replyWithHTML(
        `❌ Invalid length!\n\nString must be 1-4 characters.\n\nYou entered: <code>${vanityString}</code> (${vanityString.length} chars)`,
        { reply_markup: { force_reply: true } }
      );
      return;
    }
    
    const BASE58_CHARS = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    if (!vanityString.split('').every(c => BASE58_CHARS.includes(c))) {
      await ctx.replyWithHTML(
        `❌ Invalid Base58 character!\n\n<b>Cannot use:</b> 0 (zero), O (capital), I (capital), l (lowercase L)\n\n<b>Can use:</b> lowercase i, uppercase L, all numbers except 0, all other letters`,
        { reply_markup: { force_reply: true } }
      );
      return;
    }
    
    ctx.session.vanityString = vanityString;
    
    await ctx.replyWithHTML(
      `<b>Case Sensitivity</b>\n\n<code>${vanityString}</code> vs <code>${vanityString.toLowerCase()}</code>?\n\nShould search be case-sensitive?`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '🔤 Sensitive', callback_data: 'case_yes' },
            { text: '🔡 Insensitive (faster)', callback_data: 'case_no' }
          ]]
        }
      }
    );
  } catch (err) {
    console.error('Text handler error:', err);
  }
});

bot.action(['case_yes', 'case_no'], async (ctx) => {
  try {
    await ctx.answerCbQuery();
    
    const caseSensitive = ctx.match[0] === 'case_yes';
    const searchType = ctx.session.searchType;
    const vanityString = ctx.session.vanityString;
    const chatId = ctx.chat.id;
    const userId = ctx.from.id;
    
    const queueSize = await getQueueSize();
    
    const waitMsg = await ctx.replyWithHTML(
      `⏳ <b>Queued for generation!</b>\n\n` +
      `Type: ${searchType}\nString: <code>${vanityString}</code>\n` +
      `Case: ${caseSensitive ? '🔤 Sensitive' : '🔡 Insensitive'}\n\n` +
      `📊 Queue position: #${queueSize.waiting + 1}\n` +
      `⚙️ ${queueSize.active} generation(s) in progress...`
    );
    
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
      ctx
    ).catch(err => console.error(`[User ${userId}] Unhandled: ${err.message}`));
  } catch (err) {
    console.error('Case sensitivity handler error:', err);
  }
});

bot.action(['start_gen'], async (ctx) => {
  try {
    await ctx.answerCbQuery();
    
    await ctx.replyWithHTML(
      `<b>Vanity Address Generation</b>\n\nWhat do you want to find?`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '📍 Prefix', callback_data: 'type_prefix' },
            { text: '🔚 Suffix', callback_data: 'type_suffix' }
          ]]
        }
      }
    );
  } catch (err) {
    console.error('Start gen action error:', err);
  }
});

bot.catch((err, ctx) => {
  console.error('Bot error:', err);
  ctx.replyWithHTML(`❌ Error: <code>${err.message}</code>`).catch(() => {});
});

console.log('\n🚀 Solana Vanity Bot starting...');

bot.launch({
  allowedUpdates: ['message', 'callback_query']
});

console.log('✅ Bot is POLLING - waiting for messages...');
console.log('✅ /info and /stats commands should now work!\n');

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
