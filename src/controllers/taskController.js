const Task = require("../models/Task");

const createTask = async (req, res, next) => {
    try {
        const task = await Task.create({ ...req.body, owner: req.user._id });
        res.status(201).json(task);
    } catch (error) {
        next(error);
    }
};

const getTasks = async (req, res, next) => {
    try {
        const { status, priority, search, sort = "-createdAt", page = 1, limit = 10 } = req.query;
        const filter = { owner: req.user._id };
        if (status) filter.status = status;
        if (priority) filter.priority = priority;
        if (search) filter.$or = [
            { title: { $regex: search, $options: "i" } },
            { description: { $regex: search, $options: "i" } }
        ];

        const allowedSortFields = new Set(["createdAt", "updatedAt", "title", "priority", "dueDate", "status"]);
        const requestedSort = String(sort).replace(/^-/, "");
        const sortOrder = String(sort).startsWith("-") ? -1 : 1;
        const sortQuery = allowedSortFields.has(requestedSort) ? { [requestedSort]: sortOrder } : { createdAt: -1 };
        const pageNumber = Math.max(Number(page) || 1, 1);
        const pageSize = Math.min(Math.max(Number(limit) || 10, 1), 100);
        const [tasks, total] = await Promise.all([
            Task.find(filter).populate("owner", "name email").sort(sortQuery).skip((pageNumber - 1) * pageSize).limit(pageSize),
            Task.countDocuments(filter)
        ]);

        res.json({ tasks, pagination: { page: pageNumber, limit: pageSize, total, pages: Math.ceil(total / pageSize) } });
    } catch (error) {
        next(error);
    }
};

const getTaskStats = async (req, res, next) => {
    try {
        const stats = await Task.aggregate([
            { $match: { owner: req.user._id } },
            { $group: { _id: "$status", count: { $sum: 1 } } },
            { $sort: { count: -1 } }
        ]);
        res.json(stats);
    } catch (error) {
        next(error);
    }
};

const updateTask = async (req, res, next) => {
    try {
        const task = await Task.findOneAndUpdate(
            { _id: req.params.id, owner: req.user._id },
            req.body,
            { new: true, runValidators: true }
        ).populate("owner", "name email");
        if (!task) return res.status(404).json({ message: "Task not found" });
        res.json(task);
    } catch (error) {
        next(error);
    }
};

const deleteTask = async (req, res, next) => {
    try {
        const task = await Task.findOneAndDelete({ _id: req.params.id, owner: req.user._id });
        if (!task) return res.status(404).json({ message: "Task not found" });
        res.json({ message: "Task deleted" });
    } catch (error) {
        next(error);
    }
};

module.exports = { createTask, getTasks, getTaskStats, updateTask, deleteTask };