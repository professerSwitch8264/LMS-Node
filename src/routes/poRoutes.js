const express = require('express');
const {
  getPos,
  getPoTable,
  createRegisterCarHandler,
  createTruckArrivalHandler,
  createTruckDepartureHandler,
  createCancelPoHandler,
  createReschedulePoHandler,
  createSaveOfficePoHandler,
  createImportOfficePoHandler,
  createAssignDockHandler,
  createIssueTicketHandler,
  createSendLcTicketHandler,
  createOutsideTaskHandler,
  createSetUrgentPoHandler,
} = require('../controllers/poController');
const { requirePermission: can } = require('../middleware/auth');
const { auditRoute } = require('../services/auditService');
const { PO } = require('../services/auditEvents');

function createPoRoutes(io) {
  const router = express.Router();
  const audit = (build) => auditRoute(io, build);

  router.get('/pos', getPos);
  router.get('/pos/table', can('canViewPoTable'), getPoTable);
  router.post('/register-car', can('canEditCarPlan'), audit(PO.saveCarPlan), createRegisterCarHandler(io));
  router.post(['/truck-arrival', '/truck-arrive'], can('canActionTruckArrival'), audit(PO.truckArrival), createTruckArrivalHandler(io));
  // รถออก: handler บันทึก audit เอง (TRUCK_DEPARTURE)
  router.post(['/truck-departure', '/truck-depart'], can('canActionTruckDeparture'), createTruckDepartureHandler(io));
  router.post(['/cancel-po', '/po-cancel'], can('canCancelPo'), audit(PO.cancel), createCancelPoHandler(io));
  router.post(['/reschedule-po', '/po-reschedule', '/reschedule-car-plan'], can('canReschedulePo'), audit(PO.reschedule), createReschedulePoHandler(io));
  router.post('/office-save', can('canEditPoData', 'canAddPo', 'canImportPo'), audit(PO.officeSave), createSaveOfficePoHandler(io));
  router.post('/office-import', can('canImportPo'), audit(PO.officeImport), createImportOfficePoHandler(io));
  router.post('/assign-dock', can('canEditDockDoor'), audit(PO.assignDock), createAssignDockHandler(io));
  router.post(['/issue-ticket', '/ticket-date'], can('canActionIssueTicket'), audit(PO.issueTicket), createIssueTicketHandler(io));
  router.post('/send-lc-ticket', can('canActionTicketSent'), audit(PO.sendLcTicket), createSendLcTicketHandler(io));
  router.post('/outside-task', can('canActionPicking', 'canActionLoading', 'canActionTruckDeparture'), audit(PO.outsideTask), createOutsideTaskHandler(io));
  router.post(['/set-urgent', '/po-urgent', '/urgent'], can('canSetUrgentPo', 'canEditPoData'), audit(PO.setUrgent), createSetUrgentPoHandler(io));

  return router;
}

module.exports = createPoRoutes;
