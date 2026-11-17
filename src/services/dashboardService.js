const { getPool } = require('../config/db');
const { TABLES } = require('../config/constants');
const { logger } = require('../utils/logger');

async function getLiveDashboardData() {
  try {
    const pool = await getPool();

    const doorsResult = await pool.request().query(`
      SELECT dock_door_id, dock_door_code, dock_door_name, is_active
      FROM ${TABLES.DOCK_DOOR}
      WHERE ISNULL(is_deleted, 0) = 0
      ORDER BY dock_door_id ASC
    `);
    const doors = doorsResult.recordset.map(row => ({
      id: row.dock_door_code,
      name: row.dock_door_name,
      loading: row.is_active === 1 || row.is_active === true,
      is_active: Number(row.is_active),
    }));

    const kpiResult = await pool.request().query(`
      SELECT 
        COUNT(*) as totalPos,
        SUM(CASE WHEN pick_start_date_time IS NOT NULL AND pick_finish_date_time IS NULL THEN 1 ELSE 0 END) as pickCount,
        SUM(CASE WHEN load_start_date_time IS NOT NULL AND load_finish_date_time IS NULL THEN 1 ELSE 0 END) as loadingCount,
        SUM(CASE WHEN truck_arrival IS NOT NULL AND load_start_date_time IS NULL THEN 1 ELSE 0 END) as waitingCount,
        SUM(CASE WHEN truck_departure IS NOT NULL OR process_stage = 'COMPLETED' THEN 1 ELSE 0 END) as completeCount,
        SUM(CASE WHEN license IS NULL OR license = '' THEN 1 ELSE 0 END) as noTruckCount,
        SUM(CASE WHEN license IS NOT NULL AND license <> '' THEN 1 ELSE 0 END) as registeredTruckCount,
        SUM(CASE WHEN truck_arrival IS NOT NULL AND truck_departure IS NULL THEN 1 ELSE 0 END) as onSiteTruckCount,
        SUM(CASE WHEN process_stage IN ('CANCEL', 'CANCELLED') THEN 1 ELSE 0 END) as cancelCount,
        SUM(CASE WHEN round_no > 1 THEN 1 ELSE 0 END) as rescheduleCount,
        SUM(CASE WHEN truck_arrival IS NOT NULL AND register_date IS NOT NULL AND truck_arrival > register_date THEN 1 ELSE 0 END) as notOnTimeCount
      FROM ${TABLES.PO_CURRENT_VIEW}
    `);
    const kRow = kpiResult.recordset[0] || {};
    const totalPos = kRow.totalPos || 0;
    const pickCount = kRow.pickCount || 0;
    const loadingCount = kRow.loadingCount || 0;
    const waitingCount = kRow.waitingCount || 0;
    const completeCount = kRow.completeCount || 0;
    const noTruckCount = kRow.noTruckCount || 0;
    const registeredTruckCount = kRow.registeredTruckCount || 0;
    const onSiteTruckCount = kRow.onSiteTruckCount || 0;
    const cancelCount = kRow.cancelCount || 0;
    const rescheduleCount = kRow.rescheduleCount || 0;
    const notOnTimeCount = kRow.notOnTimeCount || 0;

    const tasksResult = await pool.request().query(`
      SELECT TOP 20
        PO_No as po,
        COALESCE(NULLIF(customer_Name, ''), '-') as customer,
        COALESCE(NULLIF(license, ''), '-') as truck,
        CASE 
          WHEN truck_departure IS NOT NULL OR process_stage = 'COMPLETED' THEN 'Completed'
          WHEN load_finish_date_time IS NOT NULL OR process_stage = 'WAIT_DEPARTURE' THEN 'Waiting Departure'
          WHEN load_start_date_time IS NOT NULL THEN 'Loading'
          WHEN pick_start_date_time IS NOT NULL THEN 'Pick Order'
          ELSE 'Not started'
        END as status
      FROM ${TABLES.PO_CURRENT_VIEW}
      ORDER BY create_date DESC
    `);
    const tasks = tasksResult.recordset;

    const freqResult = await pool.request().query(`
      SELECT 
        d.dock_door_code as door,
        COUNT(r.PO_No) as orderCount,
        ISNULL(SUM(DATEDIFF(minute, r.load_start_date_time, ISNULL(r.load_finish_date_time, GETDATE()))), 0) / 60.0 as hoursSpent
      FROM ${TABLES.DOCK_DOOR} d
      LEFT JOIN ${TABLES.PO_CURRENT_VIEW} r ON (d.dock_door_id = r.dock_door_id OR d.dock_door_code = r.dock_door_code)
      WHERE ISNULL(d.is_deleted, 0) = 0
      GROUP BY d.dock_door_code, d.dock_door_id
      ORDER BY d.dock_door_id ASC
    `);
    const frequencies = freqResult.recordset.map(row => ({
      door: row.door,
      hours: Math.round(row.hoursSpent || 0),
      orders: row.orderCount || 0,
    }));

    const shipResult = await pool.request().query(`
      SELECT 
        CONVERT(varchar(10), COALESCE(register_date, order_date, create_date), 103) as planDate,
        SUM(quantity) as totalBox,
        SUM(CASE WHEN process_stage = 'COMPLETED' OR load_finish_date_time IS NOT NULL THEN quantity ELSE 0 END) as completeBox
      FROM ${TABLES.PO_CURRENT_VIEW}
      WHERE COALESCE(register_date, order_date, create_date) IS NOT NULL
      GROUP BY CONVERT(varchar(10), COALESCE(register_date, order_date, create_date), 103)
      -- planDate is a dd/mm/yyyy string; order by the real date so the result is chronological
      ORDER BY MIN(CAST(COALESCE(register_date, order_date, create_date) AS DATE)) ASC
    `);
    const shipManagement = shipResult.recordset.map(row => {
      const total = Number(row.totalBox) || 0;
      const completed = Number(row.completeBox) || 0;
      const pct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
      return {
        date: row.planDate,
        totalBox: total > 0 ? `${total.toLocaleString()} BOX` : '0 BOX',
        segments: total > 0 ? [{ percent: pct, color: '#10b981', text: `${pct}%` }] : [],
      };
    });

    return {
      customerBooking: {
        total: totalPos,
        booking: Math.max(0, totalPos - cancelCount),
        cancel: cancelCount,
        rescheduled: rescheduleCount,
      },
      truckBooking: {
        total: totalPos,
        register: registeredTruckCount,
        onSite: onSiteTruckCount,
      },
      kpi: {
        pick: pickCount,
        loading: loadingCount,
        waiting: waitingCount,
        notOnTime: notOnTimeCount,
        complete: completeCount,
        noTruck: noTruckCount,
      },
      doors,
      frequencies,
      shipManagement,
      tasks,
    };
  } catch (err) {
    logger.error('Error fetching live dashboard data:', err.message);
    return {
      customerBooking: { total: 0, booking: 0, cancel: 0, rescheduled: 0 },
      truckBooking: { total: 0, register: 0, onSite: 0 },
      kpi: { pick: 0, loading: 0, waiting: 0, notOnTime: 0, complete: 0, noTruck: 0 },
      doors: [],
      frequencies: [],
      shipManagement: [],
      tasks: [],
    };
  }
}

async function broadcastDashboardUpdate(io) {
  if (!io) return;
  try {
    const liveData = await getLiveDashboardData();
    io.emit('data', liveData);
  } catch (e) {
    logger.warn('Cannot broadcast dashboard update:', e.message);
  }
}

module.exports = {
  getLiveDashboardData,
  broadcastDashboardUpdate,
};
