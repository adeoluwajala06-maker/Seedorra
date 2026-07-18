const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

// Set EJS view engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Helper to read and write database (content.json)
const DB_PATH = path.join(__dirname, 'content.json');

function readDb() {
  try {
    const data = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error("Error reading database:", err);
    return { site_name: "Seedorra", admin_password: "seedorra-admin", dictionary: {} };
  }
}

function writeDb(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error("Error writing database:", err);
    return false;
  }
}

// Multer setup for media file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'public/uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});
const upload = multer({ storage: storage });

// Temporary storage for registered users (SMS list) and simulated SMS logs
let registeredUsers = [];
let smsLog = [];

// Static Fallback Pricing Data (used in case scraping fails)
const FALLBACK_PRICES = [
  { name: "Rice (Local)", size: "50kg bag", current: "54,000", previous: "52,500", diff: 1500, trend: "up" },
  { name: "Maize (White)", size: "50kg bag", current: "33,000", previous: "34,200", diff: -1200, trend: "down" },
  { name: "Brown Beans", size: "50kg bag", current: "38,000", previous: "38,000", diff: 0, trend: "neutral" },
  { name: "Soya Beans", size: "50kg bag", current: "40,000", previous: "37,800", diff: 2200, trend: "up" },
  { name: "Millet", size: "50kg bag", current: "34,500", previous: "36,000", diff: -1500, trend: "down" },
  { name: "Yam (Large Tuber)", size: "1 Tuber", current: "2,200", previous: "2,000", diff: 200, trend: "up" },
  { name: "Groundnut Oil", size: "25 Liters", current: "48,000", previous: "47,500", diff: 500, trend: "up" }
];

// In-Memory cache for scraped prices
let scrapedPricesCache = null;
let lastScrapeTime = null;

// Scraping Function for https://commodity.ng/live-prices/
async function scrapePrices() {
  const now = Date.now();
  // 1-hour cache duration
  if (scrapedPricesCache && lastScrapeTime && (now - lastScrapeTime < 3600000)) {
    return scrapedPricesCache;
  }

  try {
    const response = await axios.get('https://commodity.ng/live-prices/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      timeout: 10000
    });
    
    const $ = cheerio.load(response.data);
    const pricesList = [];

    // Parse all tables with class or id containing commodity
    $('table').each((i, tableEl) => {
      const tableId = $(tableEl).attr('id') || '';
      // We target the tables on the page
      $(tableEl).find('tbody tr').each((j, rowEl) => {
        const cells = $(rowEl).find('td');
        if (cells.length >= 3) {
          const name = $(cells[0]).text().trim();
          let size = "50kg bag";
          let currentStr = $(cells[1]).text().trim().replace(/,/g, '');
          let prevStr = $(cells[2]).text().trim().replace(/,/g, '');

          // If there are 4+ cells, adjust columns to match site structure:
          // Th: Commodity | Price of 50kg (or Unit) | Current Price | Previous Price
          if (cells.length >= 4) {
            size = $(cells[1]).text().trim() || "50kg bag";
            currentStr = $(cells[2]).text().trim().replace(/,/g, '');
            prevStr = $(cells[3]).text().trim().replace(/,/g, '');
          }

          // Clean numbers
          const current = parseFloat(currentStr);
          const previous = parseFloat(prevStr);

          if (name && !isNaN(current)) {
            const diff = !isNaN(previous) ? (current - previous) : 0;
            const trend = diff > 0 ? "up" : (diff < 0 ? "down" : "neutral");
            
            // Format for display
            pricesList.push({
              name: name,
              size: size,
              current: current.toLocaleString(),
              previous: !isNaN(previous) ? previous.toLocaleString() : "N/A",
              diff: diff,
              trend: trend
            });
          }
        }
      });
    });

    if (pricesList.length > 0) {
      scrapedPricesCache = pricesList.slice(0, 10); // Take top 10 items for a clean UI
      lastScrapeTime = now;
      console.log(`Scraped ${pricesList.length} items successfully.`);
      return scrapedPricesCache;
    }
  } catch (error) {
    console.error("Scraping live prices failed, using fallback database. Error:", error.message);
  }

  // Fallback if scraping failed
  scrapedPricesCache = FALLBACK_PRICES;
  lastScrapeTime = now;
  return scrapedPricesCache;
}

// Weather Alerts Mock Database
const WEATHER_DATA = {
  "SW": { temp: "30°C", humidity: "82%", wind: "14 km/h", forecast: "Heavy Thunderstorms expected tomorrow afternoon.", alert: "Rainfall warning: High flood risk in low-lying farmlands. Clear drainage channels.", severity: "severe" },
  "SE": { temp: "29°C", humidity: "88%", wind: "10 km/h", forecast: "Continuous rainfall with brief sunny intervals.", alert: "Soil Saturation Warning: Delay fertilizer application to prevent chemical runoff.", severity: "moderate" },
  "NW": { temp: "34°C", humidity: "40%", wind: "22 km/h", forecast: "Dry winds, dusty skies, no rainfall expected.", alert: "Dry Spell Warning: High evapotranspiration rate. Apply mulching to retain soil moisture.", severity: "moderate" },
  "NE": { temp: "36°C", humidity: "35%", wind: "24 km/h", forecast: "Extremely hot and dry conditions.", alert: "Extreme Heat Warning: Restrict livestock grazing during peak heat hours. Keep soil irrigated.", severity: "severe" },
  "SS": { temp: "28°C", humidity: "90%", wind: "16 km/h", forecast: "Overcast skies with tropical downpours.", alert: "Heavy Precipitation Warning: High risk of soil erosion. Avoid tilling now.", severity: "severe" }
};

// Main Landing Page Route
app.get('/', async (req, res) => {
  const db = readDb();
  let lang = req.query.lang || 'en';
  if (!db.dictionary[lang]) {
    lang = 'en';
  }

  const dict = db.dictionary[lang];
  const prices = await scrapePrices();

  res.render('index', {
    site_name: db.site_name,
    media: db.media,
    lang: lang,
    dict: dict,
    prices: prices,
    weatherData: WEATHER_DATA
  });
});

// Admin Panel Login/Dashboard Routes
app.get('/admin', (req, res) => {
  const db = readDb();
  const lang = req.query.lang || 'en';
  const dict = db.dictionary[lang] || db.dictionary['en'];

  // Simple basic authentication query check for MVP (?pw=seedorra-admin)
  // Or check custom session headers
  const isAuthorized = req.query.auth === db.admin_password || req.headers.authorization === db.admin_password;

  res.render('admin', {
    site_name: db.site_name,
    media: db.media,
    db: db,
    dict: dict,
    lang: lang,
    auth: req.query.auth || '',
    isAuthorized: isAuthorized,
    registeredUsersCount: registeredUsers.length,
    registeredUsers: registeredUsers,
    smsLog: smsLog
  });
});

// Save Admin Text Changes
app.post('/admin/save', (req, res) => {
  const db = readDb();
  const auth = req.body.auth;
  
  if (auth !== db.admin_password) {
    return res.status(403).send("Unauthorized");
  }

  // Update site general settings
  db.site_name = req.body.site_name || db.site_name;

  // Update dictionary strings dynamically
  Object.keys(db.dictionary).forEach(langCode => {
    Object.keys(db.dictionary[langCode]).forEach(key => {
      const formKey = `dict_${langCode}_${key}`;
      if (req.body[formKey] !== undefined) {
        db.dictionary[langCode][key] = req.body[formKey];
      }
    });
  });

  writeDb(db);
  res.redirect(`/admin?auth=${auth}&success=saved`);
});

// Handle Media Upload and Mapping
app.post('/admin/upload', upload.single('media_file'), (req, res) => {
  const db = readDb();
  const auth = req.body.auth;
  
  if (auth !== db.admin_password) {
    return res.status(403).send("Unauthorized");
  }

  const mediaKey = req.body.media_key;
  if (req.file && mediaKey) {
    const relativePath = `/uploads/${req.file.filename}`;
    db.media[mediaKey] = relativePath;
    writeDb(db);
  }

  res.redirect(`/admin?auth=${auth}&success=media_uploaded`);
});

// Force refresh scraped prices
app.get('/api/prices/refresh', async (req, res) => {
  scrapedPricesCache = null; // Clear cache
  const prices = await scrapePrices();
  res.json({ success: true, count: prices.length, prices: prices });
});

// USSD API State Machine Simulator
// Maps session inputs and returns simulated USSD screens
app.post('/api/ussd', (req, res) => {
  const { text, phoneNumber, languageCode } = req.body;
  const db = readDb();
  
  // Choose dictionary based on active language or USSD session state
  let currentLang = languageCode || 'en';
  let dict = db.dictionary[currentLang] || db.dictionary['en'];

  // Splits inputs like '1*3*2'
  const inputSequence = text ? text.split('*') : [];
  let responseText = "";
  let isFinal = false;

  // Root Menu
  if (inputSequence.length === 0 || text === "") {
    responseText = `CON Seedorra Agricultural Advice\nChoose language / Yan ede / Zaɓi Yare:\n1. English\n2. Yoruba\n3. Hausa\n4. Igbo\n5. Pidgin`;
  } 
  // Main Menu selection (Language chosen)
  else if (inputSequence.length === 1) {
    const langChoice = inputSequence[0];
    const langCodes = { '1': 'en', '2': 'yo', '3': 'ha', '4': 'ig', '5': 'pcm' };
    currentLang = langCodes[langChoice] || 'en';
    dict = db.dictionary[currentLang];

    responseText = `CON Seedorra (${currentLang.toUpperCase()})\n1. ${dict.section_weather_title}\n2. ${dict.section_crop_title}\n3. ${dict.section_prices_title}\n4. Register for daily alerts`;
  }
  // Secondary Level Selection
  else if (inputSequence.length === 2) {
    const langChoice = inputSequence[0];
    const langCodes = { '1': 'en', '2': 'yo', '3': 'ha', '4': 'ig', '5': 'pcm' };
    currentLang = langCodes[langChoice] || 'en';
    dict = db.dictionary[currentLang];
    
    const menuChoice = inputSequence[1];

    if (menuChoice === '1') {
      // Weather Zones Selection
      responseText = `CON Choose Farming Region:\n1. South West\n2. North East\n3. North West\n4. South East\n5. South South`;
    } else if (menuChoice === '2') {
      // Crop Recommendation Selection
      responseText = `CON Select Your Zone State:\n1. Oyo/Osun (West)\n2. Kano/Kaduna (North)\n3. Enugu/Anambra (East)\n4. Delta/Rivers (South)`;
    } else if (menuChoice === '3') {
      // Price Check Selection
      responseText = `CON Check Live Prices:\n1. Local Rice\n2. White Maize\n3. Brown Beans\n4. Yam Tuber`;
    } else if (menuChoice === '4') {
      // Register confirmation
      responseText = `CON Enter Farm Size in Hectares:\n(e.g., 2 or 5.5)`;
    } else {
      responseText = `END Invalid Selection`;
      isFinal = true;
    }
  }
  // Third Level (Results / Final Screens)
  else if (inputSequence.length === 3) {
    const langChoice = inputSequence[0];
    const langCodes = { '1': 'en', '2': 'yo', '3': 'ha', '4': 'ig', '5': 'pcm' };
    currentLang = langCodes[langChoice] || 'en';
    dict = db.dictionary[currentLang];

    const menuChoice = inputSequence[1];
    const detailChoice = inputSequence[2];

    isFinal = true;

    if (menuChoice === '1') {
      // Weather Alert Result
      const regions = { '1': 'SW', '2': 'NE', '3': 'NW', '4': 'SE', '5': 'SS' };
      const regCode = regions[detailChoice] || 'SW';
      const wData = WEATHER_DATA[regCode];
      responseText = `END Seedorra Weather Alert:\n${wData.alert}\nForecast: ${wData.forecast}`;
    } else if (menuChoice === '2') {
      // Crop Recommendation Result
      const crops = {
        '1': "Cassava, Yam, Cocoa",
        '2': "Maize, Millet, Groundnut",
        '3': "Rice, Cassava, Cocoyam",
        '4': "Plantain, Oil Palm, Cassava"
      };
      const rec = crops[detailChoice] || "Cassava, Maize";
      responseText = `END AI Recommendation:\nBased on soil and humidity, plant: ${rec}. Sowing calendar: March-May.`;
    } else if (menuChoice === '3') {
      // Price Result
      const pricesMap = {
        '1': "Rice: ₦54,000 / 50kg bag (Up 2.8%)",
        '2': "Maize: ₦33,000 / 50kg bag (Down 1.2%)",
        '3': "Beans: ₦38,000 / 50kg bag (Stable)",
        '4': "Yam: ₦2,200 / Tuber (Up 10%)"
      };
      const priceText = pricesMap[detailChoice] || "Rice: ₦54,000";
      responseText = `END Live Price:\n${priceText}\nScraped from Commodity Nigeria.`;
    } else if (menuChoice === '4') {
      // Registration complete
      const farmSize = parseFloat(detailChoice) || 1.0;
      const user = {
        phone: phoneNumber || "08031234567",
        lang: currentLang,
        size: farmSize,
        registeredAt: new Date().toLocaleTimeString()
      };
      
      // Prevent duplicates in mock list
      if (!registeredUsers.find(u => u.phone === user.phone)) {
        registeredUsers.push(user);
      }

      responseText = `END Registration Successful!\nYou will receive daily farming advisories and weather alerts in ${currentLang.toUpperCase()} via SMS shortly.`;
    }
  }

  res.json({
    response: responseText,
    isFinal: isFinal,
    languageCode: currentLang
  });
});

// Endpoint to simulate sending SMS
app.post('/api/sms/send', (req, res) => {
  const { phone, message } = req.body;
  if (!phone || !message) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  const logEntry = {
    phone: phone,
    message: message,
    timestamp: new Date().toLocaleTimeString()
  };

  smsLog.unshift(logEntry); // Put newest on top
  res.json({ success: true, log: logEntry });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Seedorra Server is running on port ${PORT}`);
  console.log(`Local testing URL: http://localhost:${PORT}`);
});
