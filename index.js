require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Initialize Firebase
const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG || '{}');
admin.initializeApp({
  credential: admin.credential.cert(firebaseConfig),
  databaseURL: process.env.FIREBASE_DB_URL || ''
});
const db = admin.firestore();

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// WhatsApp Token
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'call360webhook';

// Health check endpoint
app.get('/', (req, res) => {
  res.json({ status: 'Call360 WhatsApp Webhook is running' });
});

// Webhook verification (GET)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  console.log(`[Webhook Verify] Mode: ${mode}, Token: ${token ? 'provided' : 'missing'}`);

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Webhook Verify] VALID VERIFICATION TOKEN');
    res.status(200).send(challenge);
  } else {
    console.error('[Webhook Verify] INVALID VERIFICATION TOKEN');
    res.sendStatus(403);
  }
});

// Webhook events (POST)
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('[Webhook Event] Received:', JSON.stringify(body, null, 2));

    // Verify signature
    const signature = req.get('x-hub-signature-256');
    if (!verifySignature(JSON.stringify(body), signature)) {
      console.error('[Webhook Event] Invalid signature');
      return res.sendStatus(403);
    }

    // Process webhook
    if (body.object === 'whatsapp_business_account') {
      for (const entry of body.entry) {
        for (const change of entry.changes) {
          if (change.field === 'messages') {
            await handleWhatsAppMessage(change.value);
          }
        }
      }
    }

    res.status(200).json({ success: true });
  } catch (error) {
    console.error('[Webhook Event] Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Verify WhatsApp signature
function verifySignature(body, signature) {
  if (!signature) return false;
  
  const appSecret = process.env.WHATSAPP_APP_SECRET || 'test-secret';
  const hash = crypto
    .createHmac('sha256', appSecret)
    .update(body)
    .digest('hex');
  
  const expected = `sha256=${hash}`;
  return signature === expected;
}

// Handle WhatsApp messages
async function handleWhatsAppMessage(messageData) {
  try {
    console.log('[Message Handler] Processing message data');
    
    const messages = messageData.messages || [];
    const contacts = messageData.contacts || [];
    
    for (const message of messages) {
      const phoneNumber = contacts[0]?.wa_id || message.from;
      const timestamp = message.timestamp;
      const messageId = message.id;
      const messageType = message.type;
      
      console.log(`[Message Handler] Phone: ${phoneNumber}, Type: ${messageType}`);
      
      // Only process text messages
      if (messageType === 'text' && message.text?.body) {
        const messageText = message.text.body;
        
        // Get or create conversation
        const conversationRef = db.collection('conversations').doc(phoneNumber);
        const conversationSnap = await conversationRef.get();
        
        let conversation = conversationSnap.data() || {};
        const messageCount = conversation.messageCount || 0;
        
        console.log(`[Message Handler] Conversation msg count: ${messageCount}`);
        
        // Check if conversation has less than 100 messages
        if (messageCount < 100) {
          // Save to Firebase
          await saveMessageToFirebase(
            phoneNumber,
            messageId,
            messageText,
            timestamp,
            messageType
          );
          
          // Update conversation
          await conversationRef.update({
            lastMessage: messageText,
            lastTimestamp: timestamp,
            messageCount: admin.firestore.FieldValue.increment(1),
            unreadCount: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.Timestamp.now()
          });
          
          console.log(`[Message Handler] Saved to Firebase (msg #${messageCount + 1})`);
        } else {
          // Save to Supabase archive
          await saveMessageToSupabase(
            phoneNumber,
            messageId,
            messageText,
            timestamp,
            messageType
          );
          
          // Update conversation
          await conversationRef.update({
            lastMessage: messageText,
            lastTimestamp: timestamp,
            archivedCount: admin.firestore.FieldValue.increment(1),
            unreadCount: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.Timestamp.now()
          });
          
          console.log(`[Message Handler] Archived to Supabase`);
        }
      }
    }
  } catch (error) {
    console.error('[Message Handler] Error:', error);
  }
}

// Save message to Firebase
async function saveMessageToFirebase(phoneNumber, messageId, text, timestamp, type) {
  try {
    const messagesRef = db.collection('conversations').doc(phoneNumber).collection('messages');
    
    await messagesRef.doc(messageId).set({
      id: messageId,
      text: text,
      timestamp: new Date(timestamp * 1000),
      type: type,
      saved: 'firebase',
      createdAt: admin.firestore.Timestamp.now()
    });
    
    console.log(`[Firebase] Message ${messageId} saved`);
  } catch (error) {
    console.error('[Firebase] Save error:', error);
  }
}

// Save message to Supabase
async function saveMessageToSupabase(phoneNumber, messageId, text, timestamp, type) {
  try {
    const { data, error } = await supabase
      .from('messages_archive')
      .insert([
        {
          phone_number: phoneNumber,
          message_id: messageId,
          text: text,
          timestamp: new Date(timestamp * 1000),
          type: type,
          created_at: new Date()
        }
      ]);
    
    if (error) {
      console.error('[Supabase] Insert error:', error);
    } else {
      console.log(`[Supabase] Message ${messageId} archived`);
    }
  } catch (error) {
    console.error('[Supabase] Save error:', error);
  }
}

// Error handling
app.use((err, req, res, next) => {
  console.error('[Error Handler]', err);
  res.status(500).json({ error: err.message });
});

// Start server
app.listen(PORT, () => {
  console.log(`[Server] Call360 Webhook running on http://localhost:${PORT}`);
  console.log(`[Server] POST /webhook endpoint active`);
  console.log(`[Config] Firebase initialized: ${!!firebaseConfig.project_id}`);
  console.log(`[Config] Supabase URL: ${supabaseUrl ? 'configured' : 'missing'}`);
  console.log(`[Config] Verify Token: ${VERIFY_TOKEN}`);
});

module.exports = app;
