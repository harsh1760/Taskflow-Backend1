const express = require("express");
const { protect } = require("../middleware/authMiddleware");
const {
    createTask,
    getTasks,
    getTaskStats,
    updateTask,
    deleteTask
} = require("../controllers/taskController");

const router = express.Router();

router.use(protect);
router.get("/stats", getTaskStats);
router.route("/").get(getTasks).post(createTask);
router.route("/:id").patch(updateTask).delete(deleteTask);

module.exports = router;