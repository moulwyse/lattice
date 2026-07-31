const events = [];

function recordAudit(event) {
  events.push(event);
}

function getAuditEvents() {
  return [...events];
}

function resetAuditEvents() {
  events.length = 0;
}

module.exports = { recordAudit, getAuditEvents, resetAuditEvents };
