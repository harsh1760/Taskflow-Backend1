const express = require("express");
const { chatWithAI, aiStatus } = require("../controllers/aiController");
const { protect } = require("../middleware/authMiddleware");
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");

const router = express.Router();
const chatRateLimit = rateLimit({
    windowMs: 60 * 1000,
    limit: 10,
    keyGenerator: (req) => String(req.user?._id || ipKeyGenerator(req.ip)),
    message: {
        success: false,
        action: null,
        code: "AI_RATE_LIMITED",
        message: "AI Assistant is temporarily busy. Please try again in a moment.",
    },
});

// AI Assistant
router.post("/chat", protect, chatRateLimit, chatWithAI);
router.get("/status", protect, aiStatus);

module.exports = router;