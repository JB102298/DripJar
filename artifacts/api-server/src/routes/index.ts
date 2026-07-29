import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import profileRouter from "./profile.js";
import dashboardRouter from "./dashboard.js";
import jarsRouter from "./jars.js";
import membersRouter from "./members.js";
import invitationsRouter from "./invitations.js";
import contributionsRouter from "./contributions.js";
import schedulesRouter from "./schedules.js";
import milestonesRouter from "./milestones.js";
import commitmentsRouter from "./commitments.js";
import agreementsRouter from "./agreements.js";
import notificationsRouter from "./notifications.js";
import activityRouter from "./activity.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use(authRouter);
router.use(profileRouter);
router.use(dashboardRouter);
router.use(jarsRouter);
router.use(membersRouter);
router.use(invitationsRouter);
router.use(contributionsRouter);
router.use(schedulesRouter);
router.use(milestonesRouter);
router.use(commitmentsRouter);
router.use(agreementsRouter);
router.use(notificationsRouter);
router.use(activityRouter);

export default router;
