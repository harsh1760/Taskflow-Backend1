const express = require("express");
const { protect, adminOnly } = require("../middleware/authMiddleware");
const {
    getUsers,
    getAllTasks,
    getOverview,
    getStats,
    updateUserRole,
    deleteUser,
    deleteTask
} = require("../controllers/adminController");

const router = express.Router();

router.use(protect, adminOnly);
router.get("/overview", getOverview);
router.get("/stats", getStats);
router.get("/users", getUsers);
router.patch("/users/:id", updateUserRole);
router.patch("/users/:id/role", updateUserRole);
router.delete("/users/:id", deleteUser);
router.get("/tasks", getAllTasks);
router.delete("/tasks/:id", deleteTask);

module.exports = router;