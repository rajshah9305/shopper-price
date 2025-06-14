// server.js - Main Express.js server
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const cron = require('node-cron');
const axios = require('axios');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/shopping_tracker', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// User Schema
const userSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  notifications: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

// Product Schema
const productSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  url: { type: String, required: true },
  title: { type: String, required: true },
  currentPrice: { type: Number, required: true },
  targetPrice: { type: Number },
  image: { type: String },
  store: { type: String, required: true },
  category: { type: String },
  priceHistory: [{
    price: { type: Number, required: true },
    date: { type: Date, default: Date.now }
  }],
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now },
  lastChecked: { type: Date, default: Date.now }
});

// Deal Schema
const dealSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  originalPrice: { type: Number, required: true },
  salePrice: { type: Number, required: true },
  discount: { type: Number, required: true },
  url: { type: String, required: true },
  image: { type: String },
  store: { type: String, required: true },
  category: { type: String },
  validUntil: { type: Date },
  isActive: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Product = mongoose.model('Product', productSchema);
const Deal = mongoose.model('Deal', dealSchema);

// Email transporter
const transporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// JWT middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret', (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// Price scraping function
async function scrapePrice(url) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    let price = null;
    let title = '';
    let image = '';
    let store = '';

    // Amazon
    if (url.includes('amazon.')) {
      price = $('.a-price-whole').first().text().replace(/[^\d.]/g, '') || 
             $('.a-offscreen').first().text().replace(/[^\d.]/g, '');
      title = $('#productTitle').text().trim();
      image = $('#landingImage').attr('src') || $('.a-dynamic-image').first().attr('src');
      store = 'Amazon';
    }
    
    // eBay
    else if (url.includes('ebay.')) {
      price = $('.price-current').text().replace(/[^\d.]/g, '') ||
             $('.notranslate').first().text().replace(/[^\d.]/g, '');
      title = $('.x-item-title-label').text().trim();
      image = $('#icImg').attr('src');
      store = 'eBay';
    }
    
    // Walmart
    else if (url.includes('walmart.')) {
      price = $('[data-testid="price-current"]').text().replace(/[^\d.]/g, '') ||
             $('.price-current').text().replace(/[^\d.]/g, '');
      title = $('h1[data-testid="product-title"]').text().trim();
      image = $('img[data-testid="hero-image-container"]').attr('src');
      store = 'Walmart';
    }
    
    // Best Buy
    else if (url.includes('bestbuy.')) {
      price = $('.sr-only:contains("current price")').parent().text().replace(/[^\d.]/g, '') ||
             $('.pricing-price__range').first().text().replace(/[^\d.]/g, '');
      title = $('.sku-title h1').text().trim();
      image = $('.primary-image').attr('src');
      store = 'Best Buy';
    }
    
    // Target
    else if (url.includes('target.')) {
      price = $('[data-test="product-price"]').text().replace(/[^\d.]/g, '');
      title = $('[data-test="product-title"]').text().trim();
      image = $('img[data-test="hero-image"]').attr('src');
      store = 'Target';
    }

    return {
      price: price ? parseFloat(price) : null,
      title: title || 'Unknown Product',
      image: image || '',
      store: store || 'Unknown Store'
    };

  } catch (error) {
    console.error('Scraping error:', error.message);
    return null;
  }
}

// Send notification email
async function sendNotification(user, product, oldPrice, newPrice) {
  if (!user.notifications) return;

  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: user.email,
    subject: `Price Drop Alert: ${product.title}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #28a745;">🎉 Great News! Price Drop Alert</h2>
        <div style="border: 1px solid #ddd; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3>${product.title}</h3>
          <img src="${product.image}" alt="Product" style="max-width: 200px; height: auto;" />
          <p><strong>Store:</strong> ${product.store}</p>
          <p><strong>Previous Price:</strong> <span style="text-decoration: line-through; color: #dc3545;">$${oldPrice}</span></p>
          <p><strong>New Price:</strong> <span style="color: #28a745; font-size: 1.2em; font-weight: bold;">$${newPrice}</span></p>
          <p><strong>You Save:</strong> <span style="color: #28a745; font-weight: bold;">$${(oldPrice - newPrice).toFixed(2)} (${Math.round(((oldPrice - newPrice) / oldPrice) * 100)}% off)</span></p>
          <a href="${product.url}" style="display: inline-block; background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-top: 10px;">View Product</a>
        </div>
        <p style="color: #6c757d; font-size: 0.9em;">Happy shopping! 🛍️</p>
      </div>
    `
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Notification sent to ${user.email}`);
  } catch (error) {
    console.error('Email error:', error);
  }
}

// Routes

// Auth routes
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, email, password } = req.body;
    
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists' });
    }

    const hashedPassword = await bcrypt.hash(password, 12);
    const user = new User({ username, email, password: hashedPassword });
    await user.save();

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'fallback_secret');
    res.status(201).json({ token, user: { id: user._id, username, email } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'fallback_secret');
    res.json({ token, user: { id: user._id, username: user.username, email: user.email } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Product routes
app.post('/api/products', authenticateToken, async (req, res) => {
  try {
    const { url, targetPrice } = req.body;
    
    // Scrape initial product data
    const scrapedData = await scrapePrice(url);
    if (!scrapedData || !scrapedData.price) {
      return res.status(400).json({ error: 'Unable to scrape product data. Please check the URL.' });
    }

    const product = new Product({
      userId: req.user.userId,
      url,
      title: scrapedData.title,
      currentPrice: scrapedData.price,
      targetPrice,
      image: scrapedData.image,
      store: scrapedData.store,
      priceHistory: [{ price: scrapedData.price }]
    });

    await product.save();
    res.status(201).json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const products = await Product.find({ userId: req.user.userId, isActive: true });
    res.json(products);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, userId: req.user.userId });
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const { targetPrice } = req.body;
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.userId },
      { targetPrice },
      { new: true }
    );
    
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    res.json(product);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const product = await Product.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.userId },
      { isActive: false },
      { new: true }
    );
    
    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    
    res.json({ message: 'Product removed from tracking' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Deals routes
app.get('/api/deals', async (req, res) => {
  try {
    const { category, minDiscount } = req.query;
    let query = { isActive: true };
    
    if (category) query.category = category;
    if (minDiscount) query.discount = { $gte: parseInt(minDiscount) };
    
    const deals = await Deal.find(query)
      .sort({ discount: -1, createdAt: -1 })
      .limit(50);
    
    res.json(deals);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Analytics routes
app.get('/api/analytics/savings', authenticateToken, async (req, res) => {
  try {
    const products = await Product.find({ userId: req.user.userId });
    
    let totalSavings = 0;
    let bestDeal = null;
    let bestDealSavings = 0;
    
    products.forEach(product => {
      if (product.priceHistory.length > 1) {
        const originalPrice = product.priceHistory[0].price;
        const currentPrice = product.currentPrice;
        const savings = originalPrice - currentPrice;
        
        if (savings > 0) {
          totalSavings += savings;
          
          if (savings > bestDealSavings) {
            bestDealSavings = savings;
            bestDeal = {
              title: product.title,
              originalPrice,
              currentPrice,
              savings,
              savingsPercent: Math.round((savings / originalPrice) * 100)
            };
          }
        }
      }
    });
    
    res.json({
      totalSavings: totalSavings.toFixed(2),
      trackedProducts: products.length,
      bestDeal
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Price check function (runs via cron)
async function checkPrices() {
  console.log('Starting price check...');
  
  try {
    const products = await Product.find({ isActive: true });
    
    for (const product of products) {
      try {
        const scrapedData = await scrapePrice(product.url);
        
        if (scrapedData && scrapedData.price) {
          const oldPrice = product.currentPrice;
          const newPrice = scrapedData.price;
          
          // Update product
          product.currentPrice = newPrice;
          product.lastChecked = new Date();
          product.priceHistory.push({ price: newPrice });
          
          // Keep only last 30 price points
          if (product.priceHistory.length > 30) {
            product.priceHistory = product.priceHistory.slice(-30);
          }
          
          await product.save();
          
          // Check if price dropped below target
          if (product.targetPrice && newPrice <= product.targetPrice && newPrice < oldPrice) {
            const user = await User.findById(product.userId);
            if (user) {
              await sendNotification(user, product, oldPrice, newPrice);
            }
          }
          
          console.log(`Updated ${product.title}: $${oldPrice} -> $${newPrice}`);
        }
        
        // Add delay to avoid being blocked
        await new Promise(resolve => setTimeout(resolve, 2000));
        
      } catch (error) {
        console.error(`Error checking ${product.title}:`, error.message);
      }
    }
    
    console.log('Price check completed');
  } catch (error) {
    console.error('Price check error:', error);
  }
}

// Schedule price checks every 4 hours
cron.schedule('0 */4 * * *', checkPrices);

// Manual price check endpoint
app.post('/api/check-prices', authenticateToken, async (req, res) => {
  try {
    checkPrices();
    res.json({ message: 'Price check started' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Shopping Tracker Agent running on port ${PORT}`);
  console.log('Database connected successfully');
  console.log('Price checking scheduled every 4 hours');
});
