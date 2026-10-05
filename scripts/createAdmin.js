const dotenv = require("dotenv");
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");
const User = require("../src/models/User");

dotenv.config();

const createAdmin = async () => {
    const { ADMIN_NAME, ADMIN_EMAIL, ADMIN_PASSWORD, MONGO_URI } = process.env;

    if (!MONGO_URI || !ADMIN_NAME || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
        throw new Error("MONGO_URI, ADMIN_NAME, ADMIN_EMAIL, and ADMIN_PASSWORD are required");
    }

    await mongoose.connect(MONGO_URI);
    const existingUser = await User.findOne({ email: ADMIN_EMAIL.toLowerCase() });
    const password = await bcrypt.hash(ADMIN_PASSWORD, 12);

    if (existingUser) {
        await User.updateOne(
            { _id: existingUser._id },
            { $set: { name: ADMIN_NAME, password, role: "admin" } }
        );
        console.log(existingUser.role === "admin" ? "Admin account credentials updated" : "Existing account promoted to admin");
        return;
    }

    await User.create({
        name: ADMIN_NAME,
        email: ADMIN_EMAIL,
        password,
        role: "admin"
    });
    console.log(`Admin account created for ${ADMIN_EMAIL}`);
};

createAdmin()
    .catch((error) => {
        console.error(`Unable to create admin: ${error.message}`);
        process.exitCode = 1;
    })
    .finally(async () => {
        if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });