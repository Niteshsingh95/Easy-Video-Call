import { Router } from "express";
import { addToHistory, getUserHistory, login, register } from "../controllers/user.controller.js";
import { validateToken } from "../controllers/tokenAuth.js";




const router = Router();

router.route("/login").post(login)
router.route("/register").post(register)
router.route("/add_to_activity").post(validateToken,addToHistory)
router.route("/get_all_activity").get(validateToken,getUserHistory)

export default router;