import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import suiDexRouter from "./sui-dex.js";
import adminRouter from "./admin.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(suiDexRouter);
router.use("/admin", adminRouter);

export default router;
