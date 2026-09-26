-- Queued job row (PT-6b1, D171, D174d): a run is enqueued before delivery.
-- Status gains 'queued'. The unique index on (org_id, campaign_id) covers both
-- queued and running jobs so a campaign has at most one active run in flight.

alter table job drop constraint job_status_check;
alter table job add constraint job_status_check check (status in ('queued', 'running', 'completed', 'failed'));

drop index job_running_campaign;
create unique index job_active_campaign on job (org_id, campaign_id) where status in ('queued', 'running');
