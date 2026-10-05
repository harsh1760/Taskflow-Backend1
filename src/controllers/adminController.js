const User = require("../models/User");
const Task = require("../models/Task");

const getUsers = async (req, res, next) => {
    try {
        const users = await User.find().select("-password").sort({ createdAt: -1 });
        res.json(users);
    } catch (error) {
        next(error);
    }
};

const getAllTasks = async (req, res, next) => {
    try {
        const tasks = await Task.find().populate("owner", "name email role").sort({ createdAt: -1 });
        res.json(tasks);
    } catch (error) {
        next(error);
    }
};

const getOverview = async (req, res, next) => {
    try {
        const [users, tasks, taskStats] = await Promise.all([
            User.countDocuments(),
            Task.countDocuments(),
            Task.aggregate([
                { $group: { _id: "$status", count: { $sum: 1 } } },
                { $sort: { count: -1 } }
            ])
        ]);
        res.json({ users, tasks, taskStats });
    } catch (error) {
        next(error);
    }
};

const getStats = getOverview;

const updateUserRole = async (req, res, next) => {
    try {
        const { role } = req.body;
        if (!["user", "admin"].includes(role)) {
            return res.status(400).json({ message: "Role must be user or admin" });
        }
        const user = await User.findByIdAndUpdate(req.params.id, { role }, { new: true }).select("-password");
        if (!user) return res.status(404).json({ message: "User not found" });
        res.json(user);
    } catch (error) {
        next(error);
    }
};

const deleteUser = async (req, res, next) => {
    try {
        if (req.params.id === req.user._id.toString()) {
            return res.status(400).json({ message: "You cannot delete your own admin account" });
        }
        const user = await User.findByIdAndDelete(req.params.id);
        if (!user) return res.status(404).json({ message: "User not found" });
        await Task.deleteMany({ owner: user._id });
        res.json({ message: "User and owned tasks deleted" });
    } catch (error) {
        next(error);
    }
};

const deleteTask = async (req, res, next) => {
    try {
        const task = await Task.findByIdAndDelete(req.params.id);
        if (!task) return res.status(404).json({ message: "Task not found" });
        res.json({ message: "Task deleted" });
    } catch (error) {
        next(error);
    }
};

module.exports = {
    getUsers,
    getAllTasks,
    getOverview,
    getStats,
    updateUserRole,
    deleteUser,
    deleteTask
};