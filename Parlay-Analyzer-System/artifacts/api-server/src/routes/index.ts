import { Router, type IRouter } from "express";
import healthRouter from "./health";
import oddsRouter from "./odds";
import configRouter from "./config";
import csvRouter from "./csv";
import seasonCsvRouter from "./season-csv";
import supabaseRouter from "./supabase";

const router: IRouter = Router();

router.use(healthRouter);
router.use(oddsRouter);
router.use(configRouter);
router.use(csvRouter);
router.use(seasonCsvRouter);
router.use(supabaseRouter);

export default router;
