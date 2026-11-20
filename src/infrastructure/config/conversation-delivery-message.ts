// Used by admin feed and detail queries; m denotes a bz_messages row.
// /send stores the caller's app ID in channel. Only the associated successful
// outbound job establishes that this row is a delivery, not a normal reply.
export const CHANNEL_DELIVERY_MESSAGE_SQL = `m.direction='out' AND (
  m.channel IN ('delivery','brain-send')
  OR EXISTS (
    SELECT 1 FROM bz_jobs send_job
     WHERE send_job.job_id=m.job_id AND send_job.target='channel-send' AND send_job.status='done'
       AND JSON_UNQUOTE(JSON_EXTRACT(send_job.metadata,'$.via'))='send'
       AND JSON_EXTRACT(send_job.metadata,'$.outbound')=CAST('true' AS JSON)
  )
)`;
