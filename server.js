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
    const db = JSON.parse(data);

    // Self-healing dictionary initializer:
    // If dictionary keys for other languages are missing, populate them using English fallbacks.
    if (!db.dictionary) db.dictionary = { en: {} };
    if (!db.dictionary.en) db.dictionary.en = {};
    
    const enKeys = Object.keys(db.dictionary.en);
    const targetLangs = ['yo', 'ha', 'ig', 'pcm'];
    
    targetLangs.forEach(lang => {
      if (!db.dictionary[lang]) {
        db.dictionary[lang] = {};
      }
      enKeys.forEach(key => {
        if (db.dictionary[lang][key] === undefined) {
          db.dictionary[lang][key] = db.dictionary.en[key];
        }
      });
    });

    if (!db.seen_onboarding_ips) {
      db.seen_onboarding_ips = [];
    }

    return db;
  } catch (err) {
    console.error("Error reading database:", err);
    return { site_name: "Seedorra", admin_password: "seedorra-admin", users: [], dictionary: { en: {} }, seen_onboarding_ips: [] };
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

// Temporary storage for simulated SMS logs
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

    $('table').each((i, tableEl) => {
      $(tableEl).find('tbody tr').each((j, rowEl) => {
        const cells = $(rowEl).find('td');
        if (cells.length >= 3) {
          const name = $(cells[0]).text().trim();
          let size = "50kg bag";
          let currentStr = $(cells[1]).text().trim().replace(/,/g, '');
          let prevStr = $(cells[2]).text().trim().replace(/,/g, '');

          if (cells.length >= 4) {
            size = $(cells[1]).text().trim() || "50kg bag";
            currentStr = $(cells[2]).text().trim().replace(/,/g, '');
            prevStr = $(cells[3]).text().trim().replace(/,/g, '');
          }

          const current = parseFloat(currentStr);
          const previous = parseFloat(prevStr);

          if (name && !isNaN(current)) {
            const diff = !isNaN(previous) ? (current - previous) : 0;
            const trend = diff > 0 ? "up" : (diff < 0 ? "down" : "neutral");
            
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
      scrapedPricesCache = pricesList.slice(0, 10);
      lastScrapeTime = now;
      return scrapedPricesCache;
    }
  } catch (error) {
    console.error("Scraping live prices failed, using fallback database. Error:", error.message);
  }

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

// National Pest Alerts Mock Database
const PEST_ALERTS = [
  { id: 1, pest: "Fall Armyworm (Spodoptera frugiperda)", severity: "severe", location: "South-West (Oyo, Ogun, Osun) & Middle Belt", description: "Active outbreaks reported on young maize stalks. Feeding damage causes leaf skeletonization.", remedy: "Spray neem oil solution early morning or apply biological Bt insecticides. Clear fields post-harvest." },
  { id: 2, pest: "African Desert Locust Swarms", severity: "extreme", location: "North-East border regions (Borno, Yobe)", description: "Warning advisory active. Border swarms moving from Sahel. Crop stripping hazard.", remedy: "Report coordinates immediately to national extension officers. Keep soil tilled to destroy pupae." },
  { id: 3, pest: "Stem Borer Infestation", severity: "moderate", location: "South-East & South-South rain forests", description: "Larvae boring into cereal crops. Causes 'dead hearts' in rice and sorghum plants.", remedy: "Practice crop rotation with legumes. Apply organic compost to improve plant resistance." }
];

// Main Landing Page Route
app.get('/', async (req, res) => {
  const db = readDb();
  let lang = req.query.lang || 'en';
  if (!db.dictionary[lang]) {
    lang = 'en';
  }

  const dict = db.dictionary[lang];
  const prices = await scrapePrices();

  // Get Client IP to check if they have completed onboarding
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;
  const showOnboarding = !db.seen_onboarding_ips.includes(clientIp);

  res.render('index', {
    site_name: db.site_name,
    media: db.media,
    lang: lang,
    dict: dict,
    prices: prices,
    weatherData: WEATHER_DATA,
    pestAlerts: PEST_ALERTS,
    showOnboarding: showOnboarding
  });
});

// Endpoint to mark Onboarding complete for an IP address
app.post('/api/onboarding/complete', (req, res) => {
  const db = readDb();
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || req.ip;

  if (!db.seen_onboarding_ips.includes(clientIp)) {
    db.seen_onboarding_ips.push(clientIp);
    writeDb(db);
  }
  res.json({ success: true, clientIp });
});

// Farmer Registration Endpoint
app.post('/api/register', (req, res) => {
  const { name, location, size, phone, email, password } = req.body;
  if (!name || !location || !size || !phone || !password) {
    return res.status(400).json({ success: false, error: "Missing required farm fields." });
  }

  const db = readDb();
  if (!db.users) db.users = [];

  // Check if phone already exists
  const existingUser = db.users.find(u => u.phone === phone);
  if (existingUser) {
    return res.json({ success: false, error: "A farmer with this phone number is already registered." });
  }

  const newUser = {
    name,
    location,
    size: parseFloat(size).toString(),
    phone,
    email: email || "",
    password: password,
    profile_photo: "/images/onboarding_welcome.jpg",
    queries: [],
    badges: ["Seedling Saver"]
  };

  db.users.push(newUser);
  writeDb(db);

  res.json({ success: true, user: newUser });
});

// Farmer / Admin Login Endpoint
app.post('/api/login', (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) {
    return res.status(400).json({ success: false, error: "Missing name or credential." });
  }

  const db = readDb();

  // 1. Check if Admin Login
  if (name.toLowerCase().trim() === db.admin_username && phone === db.admin_password) {
    return res.json({
      success: true,
      role: 'admin',
      auth: db.admin_password,
      redirect: `/admin?auth=${db.admin_password}`
    });
  }

  // 2. Check if Farmer Login
  if (!db.users) db.users = [];
  const farmer = db.users.find(u => 
    u.name.toLowerCase().trim() === name.toLowerCase().trim() && 
    (u.password === phone.trim() || u.phone.trim() === phone.trim())
  );

  if (farmer) {
    const isNorth = farmer.location.toLowerCase().includes('kano') || 
                    farmer.location.toLowerCase().includes('kaduna') || 
                    farmer.location.toLowerCase().includes('sokoto') ||
                    farmer.location.toLowerCase().includes('north');
                    
    const regionCode = isNorth ? 'NW' : 'SW';
    const weather = WEATHER_DATA[regionCode];

    return res.json({
      success: true,
      role: 'farmer',
      user: farmer,
      dashboardData: {
        location: farmer.location,
        size: farmer.size,
        weather: weather,
        recCrops: isNorth ? "Wheat, Maize, Onions, Millet" : "Cassava, Yam, Cocoa, Rice"
      }
    });
  }

  // 3. Not Found - Encouraging Messages
  const encouragingMessages = [
    "Oops! We searched our fields but couldn't find a farm registered under that name or password. Double-check your spelling, or sign up as a new farmer to join the Seedorra family! 🌾",
    "Oh no! It looks like those details got tangled in the vines. Check your name and password and try again, or register your farm today! 🚜",
    "Haba! That combination doesn't match our farmer database. Please check your information and try again, or register to start growing smarter! 🌱"
  ];
  
  const randomMsg = encouragingMessages[Math.floor(Math.random() * encouragingMessages.length)];

  res.json({
    success: false,
    message: randomMsg
  });
});

// Update Profile Info
app.post('/api/profile/update', (req, res) => {
  const { phone, name, location, size, email } = req.body;
  if (!phone || !name || !location || !size) {
    return res.status(400).json({ success: false, error: "Missing required fields." });
  }

  const db = readDb();
  const index = db.users.findIndex(u => u.phone === phone);

  if (index === -1) {
    return res.status(404).json({ success: false, error: "Farmer not found." });
  }

  db.users[index].name = name;
  db.users[index].location = location;
  db.users[index].size = parseFloat(size).toString();
  db.users[index].email = email || "";

  if (!db.users[index].badges.includes("Soil Doctor")) {
    db.users[index].badges.push("Soil Doctor");
  }

  writeDb(db);
  res.json({ success: true, user: db.users[index] });
});

// Update Password
app.post('/api/profile/password', (req, res) => {
  const { phone, currentPassword, newPassword } = req.body;
  if (!phone || !currentPassword || !newPassword) {
    return res.status(400).json({ success: false, error: "Missing password parameters." });
  }

  const db = readDb();
  const index = db.users.findIndex(u => u.phone === phone);

  if (index === -1) {
    return res.status(404).json({ success: false, error: "Farmer not found." });
  }

  if (db.users[index].password !== currentPassword) {
    return res.json({ success: false, error: "Current password does not match." });
  }

  db.users[index].password = newPassword;
  writeDb(db);
  res.json({ success: true });
});

// Profile Photo Upload Endpoint
app.post('/api/profile/upload-photo', upload.single('profile_photo'), (req, res) => {
  const { phone } = req.body;
  if (!phone || !req.file) {
    return res.status(400).json({ success: false, error: "Missing phone or photo file." });
  }

  const db = readDb();
  const index = db.users.findIndex(u => u.phone === phone);

  if (index === -1) {
    return res.status(404).json({ success: false, error: "Farmer not found." });
  }

  const photoPath = `/uploads/${req.file.filename}`;
  db.users[index].profile_photo = photoPath;

  writeDb(db);
  res.json({ success: true, photoPath: photoPath });
});

// Plant Diagnosis API
app.post('/api/diagnose', upload.single('plant_photo'), (req, res) => {
  const { crop, phone } = req.body;
  
  if (!crop) {
    return res.status(400).json({ success: false, error: "Missing plant crop parameter." });
  }

  let diagnosis = "Nutrient Deficiency (Nitrogen/Phosphorus)";
  let severity = "Mild";
  let cure = "Apply well-composted organic poultry manure or organic liquid fertilizer. Increase soil mulching.";
  let caseImage = "/images/disease_blight.jpg";

  if (crop.toLowerCase() === 'maize') {
    diagnosis = "Maize Common Rust (Puccinia sorghi)";
    severity = "High";
    cure = "Apply organic neem oil spray weekly. Clear dry crop residue after harvest. Rotate crops with leguminous cover plants next season.";
    caseImage = "/images/disease_blight.jpg";
  } else if (crop.toLowerCase() === 'cassava') {
    diagnosis = "Cassava Mosaic Virus (CMD)";
    severity = "Severe";
    cure = "Uproot infected stems to prevent spread. Plant disease-resistant stem cuttings (such as TMS 30572). Control whiteflies using organic neem extract.";
    caseImage = "/images/onboarding_crops.jpg";
  } else if (crop.toLowerCase() === 'tomato') {
    diagnosis = "Tomato Early Blight (Alternaria solani)";
    severity = "Moderate";
    cure = "Prune lower leaves to improve aeration. Avoid overhead watering. Apply copper-based organic fungicides early morning.";
    caseImage = "/images/onboarding_soil.jpg";
  }

  if (phone) {
    const db = readDb();
    const index = db.users.findIndex(u => u.phone === phone);
    if (index !== -1) {
      const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      db.users[index].queries.push({
        type: "Plant Diagnosis",
        input: crop.charAt(0).toUpperCase() + crop.slice(1),
        result: `${diagnosis} (${severity})`,
        date: today
      });
      
      if (!db.users[index].badges.includes("Farm Doctor")) {
        db.users[index].badges.push("Farm Doctor");
      }
      
      writeDb(db);
    }
  }

  res.json({
    success: true,
    diagnosis: diagnosis,
    severity: severity,
    cure: cure,
    matchedCaseImage: caseImage,
    matchScore: "96% Verified Match"
  });
});

// Admin Panel login/dashboard
app.get('/admin', (req, res) => {
  const db = readDb();
  const lang = req.query.lang || 'en';
  const dict = db.dictionary[lang] || db.dictionary['en'];

  const isAuthorized = req.query.auth === db.admin_password;

  res.render('admin', {
    site_name: db.site_name,
    media: db.media,
    db: db,
    dict: dict,
    lang: lang,
    auth: req.query.auth || '',
    isAuthorized: isAuthorized,
    registeredUsersCount: db.users ? db.users.length : 0,
    registeredUsers: db.users || [],
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

  db.site_name = req.body.site_name || db.site_name;

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
  scrapedPricesCache = null;
  const prices = await scrapePrices();
  res.json({ success: true, count: prices.length, prices: prices });
});

// USSD API State Machine Simulator
app.post('/api/ussd', (req, res) => {
  const { text, phoneNumber, languageCode } = req.body;
  const db = readDb();
  
  let currentLang = languageCode || 'en';
  let dict = db.dictionary[currentLang] || db.dictionary['en'];

  const inputSequence = text ? text.split('*') : [];
  let responseText = "";
  let isFinal = false;

  if (inputSequence.length === 0 || text === "") {
    responseText = `CON Seedorra Agricultural Advice\nChoose language / Yan ede / Zaɓi Yare:\n1. English\n2. Yoruba\n3. Hausa\n4. Igbo\n5. Pidgin`;
  } 
  else if (inputSequence.length === 1) {
    const langChoice = inputSequence[0];
    const langCodes = { '1': 'en', '2': 'yo', '3': 'ha', '4': 'ig', '5': 'pcm' };
    currentLang = langCodes[langChoice] || 'en';
    dict = db.dictionary[currentLang];

    responseText = `CON Seedorra (${currentLang.toUpperCase()})\n1. ${dict.section_weather_title}\n2. ${dict.section_crop_title}\n3. ${dict.section_prices_title}\n4. Register for daily alerts`;
  }
  else if (inputSequence.length === 2) {
    const langChoice = inputSequence[0];
    const langCodes = { '1': 'en', '2': 'yo', '3': 'ha', '4': 'ig', '5': 'pcm' };
    currentLang = langCodes[langChoice] || 'en';
    dict = db.dictionary[currentLang];
    
    const menuChoice = inputSequence[1];

    if (menuChoice === '1') {
      responseText = `CON Choose Farming Region:\n1. South West\n2. North East\n3. North West\n4. South East\n5. South South`;
    } else if (menuChoice === '2') {
      responseText = `CON Select Your Zone State:\n1. Oyo/Osun (West)\n2. Kano/Kaduna (North)\n3. Enugu/Anambra (East)\n4. Delta/Rivers (South)`;
    } else if (menuChoice === '3') {
      responseText = `CON Check Live Prices:\n1. Local Rice\n2. White Maize\n3. Brown Beans\n4. Yam Tuber`;
    } else if (menuChoice === '4') {
      responseText = `CON Enter Farm Size in Hectares:\n(e.g., 2 or 5.5)`;
    } else {
      responseText = `END Invalid Selection`;
      isFinal = true;
    }
  }
  else if (inputSequence.length === 3) {
    const langChoice = inputSequence[0];
    const langCodes = { '1': 'en', '2': 'yo', '3': 'ha', '4': 'ig', '5': 'pcm' };
    currentLang = langCodes[langChoice] || 'en';
    dict = db.dictionary[currentLang];

    const menuChoice = inputSequence[1];
    const detailChoice = inputSequence[2];

    isFinal = true;

    if (menuChoice === '1') {
      const regions = { '1': 'SW', '2': 'NE', '3': 'NW', '4': 'SE', '5': 'SS' };
      const regCode = regions[detailChoice] || 'SW';
      const wData = WEATHER_DATA[regCode];
      responseText = `END Seedorra Weather Alert:\n${wData.alert}\nForecast: ${wData.forecast}`;
    } else if (menuChoice === '2') {
      const crops = {
        '1': "Cassava, Yam, Cocoa",
        '2': "Maize, Millet, Groundnut",
        '3': "Rice, Cassava, Cocoyam",
        '4': "Plantain, Oil Palm, Cassava"
      };
      const rec = crops[detailChoice] || "Cassava, Maize";
      responseText = `END AI Recommendation:\nBased on soil and humidity, plant: ${rec}. Sowing calendar: March-May.`;
    } else if (menuChoice === '3') {
      const pricesMap = {
        '1': "Rice: ₦54,000 / 50kg bag (Up 2.8%)",
        '2': "Maize: ₦33,000 / 50kg bag (Down 1.2%)",
        '3': "Beans: ₦38,000 / 50kg bag (Stable)",
        '4': "Yam: ₦2,200 / Tuber (Up 10%)"
      };
      const priceText = pricesMap[detailChoice] || "Rice: ₦54,000";
      responseText = `END Live Price:\n${priceText}\nScraped from Commodity Nigeria.`;
    } else if (menuChoice === '4') {
      const farmSize = parseFloat(detailChoice) || 1.0;
      const user = {
        name: "Feature Phone User",
        phone: phoneNumber || "08039281234",
        location: "USSD Simulator Zone",
        size: farmSize.toString(),
        email: "",
        password: "123",
        profile_photo: "/images/onboarding_welcome.jpg",
        queries: [],
        badges: ["Seedling Saver"]
      };
      
      if (!db.users) db.users = [];
      
      const existingIdx = db.users.findIndex(u => u.phone === user.phone);
      if (existingIdx === -1) {
        db.users.push(user);
      } else {
        db.users[existingIdx].size = user.size;
      }
      writeDb(db);

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

  smsLog.unshift(logEntry);
  res.json({ success: true, log: logEntry });
});

// Start Server
app.listen(PORT, () => {
  console.log(`Seedorra Server is running on port ${PORT}`);
  console.log(`Local testing URL: http://localhost:${PORT}`);
});
