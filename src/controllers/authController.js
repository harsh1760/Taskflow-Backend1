const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const createToken = (user) => jwt.sign(
    { id: user._id, role: user.role },
    process.env.JWT_SECRET || "development-secret",
    { expiresIn: "7d" }
);

const registerUser = async (req, res) => {
    try {
        const { name, email, password } = req.body;

        // Check required fields
        if (!name || !email || !password) {
            return res.status(400).json({
                message: "Please provide name, email and password"
            });
        }

        // Check if user already exists
        const existingUser = await User.findOne({ email });

        if (existingUser) {
            return res.status(400).json({
                message: "User already exists"
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Create user
        const user = await User.create({
            name,
            email,
            password: hashedPassword,
            role: "user"
        });

        res.status(201).json({
            message: "User registered successfully",
            token: createToken(user),
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            }
        });

    } catch (error) {
        console.log(error);

        res.status(500).json({
            message: "Server error"
        });
    }
};

const loginUser = async (req, res, next) => {
    try {
        const email = String(req.body.email || "").trim().toLowerCase();
        const { password } = req.body;
        const user = await User.findOne({ email });
        const isPasswordCorrect = user
            ? await bcrypt.compare(password || "", user.password)
            : false;

        if (process.env.NODE_ENV !== "production") {
            console.log("LOGIN EMAIL:", email);
            console.log("USER FOUND:", Boolean(user));
            console.log("USER ROLE:", user?.role);
            console.log("PASSWORD MATCH:", isPasswordCorrect);
        }

        if (!user || !isPasswordCorrect) {
            return res.status(401).json({ message: "Invalid email or password" });
        }

        res.json({
            message: "Login successful",
            token: createToken(user),
            user: { id: user._id, name: user.name, email: user.email, role: user.role }
        });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    registerUser,
    loginUser
};