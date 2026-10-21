import React from 'react';

import { Layouts, Page, useFetchClient, useNotification, useRBAC } from '@strapi/strapi/admin';
import {
  Alert,
  Badge,
  Box,
  Button,
  Flex,
  Loader,
  Table,
  Tbody,
  Td,
  Th,
  Thead,
  Tr,
  Typography,
} from '@strapi/design-system';

const PLUGIN_ID = 'dropbox-backup';
const STATUS_URL = `/${PLUGIN_ID}/status`;
const RUN_URL = `/${PLUGIN_ID}/run`;

// While a backup is in flight the page polls; idle it leaves the server alone.
const POLL_INTERVAL_MS = 4000;

const PERMISSIONS = [
  { action: `plugin::${PLUGIN_ID}.read`, subject: null },
  { action: `plugin::${PLUGIN_ID}.run`, subject: null },
];

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
};

const formatDuration = (ms) => (ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`);

const BANNER_TONES = {
  warning: { background: 'warning100', borderColor: 'warning200', title: 'warning600' },
  neutral: { background: 'neutral100', borderColor: 'neutral200', title: 'neutral700' },
};

const Banner = ({ tone, title, children }) => {
  const colors = BANNER_TONES[tone];
  return (
    <Box
      background={colors.background}
      borderColor={colors.borderColor}
      hasRadius
      padding={4}
    >
      <Typography fontWeight="bold" textColor={colors.title}>
        {title}
      </Typography>{' '}
      <Typography textColor="neutral700">{children}</Typography>
    </Box>
  );
};

const HomePage = () => {
  const { get, post } = useFetchClient();
  const { toggleNotification } = useNotification();
  const { allowedActions, isLoading: isLoadingPermissions } = useRBAC(PERMISSIONS);

  const [status, setStatus] = React.useState(null);
  const [error, setError] = React.useState(null);
  const [isStarting, setIsStarting] = React.useState(false);
  const [dismissedWarningsFor, setDismissedWarningsFor] = React.useState(null);

  const refresh = React.useCallback(async () => {
    try {
      const { data } = await get(STATUS_URL);
      setStatus(data);
      setError(null);
      return data;
    } catch (err) {
      setError(err);
      return null;
    }
  }, [get]);

  React.useEffect(() => {
    refresh();
  }, [refresh]);

  // Poll only while a run is actually in flight.
  React.useEffect(() => {
    if (!status?.running) return undefined;
    const id = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [status?.running, refresh]);

  const start = async (includeMedia = false) => {
    setIsStarting(true);
    try {
      await post(RUN_URL, { includeMedia });
      toggleNotification({
        type: 'info',
        message: includeMedia
          ? 'Database backup plus media mirror started. The first media pass is long; later ones are quick.'
          : 'Database backup started. This usually takes a minute or two.',
      });
      await refresh();
    } catch (err) {
      toggleNotification({
        type: 'danger',
        message: err.response?.data?.error?.message ?? 'Could not start the backup.',
      });
    } finally {
      setIsStarting(false);
    }
  };

  if (isLoadingPermissions || (!status && !error)) {
    return <Page.Loading />;
  }

  if (error) {
    return <Page.Error />;
  }

  const runs = status.runs ?? [];
  const lastRun = runs[0];

  return (
    <Layouts.Root>
      <Page.Title>Dropbox backup</Page.Title>

      <Layouts.Header
        title="Dropbox backup"
        subtitle={
          status.configured
            ? `${status.folder} · database ${status.schedule || 'off'} (keep ${status.keep}) · media ${status.mediaSchedule || 'off'} (keep ${status.mediaKeep})`
            : 'Not configured'
        }
        primaryAction={
          <Flex gap={2}>
            <Button
              variant="secondary"
              onClick={() => start(true)}
              disabled={!status.configured || !allowedActions.canRun || status.running}
            >
              Back up + mirror media
            </Button>
            <Button
              onClick={() => start(false)}
              loading={isStarting || status.running}
              disabled={!status.configured || !allowedActions.canRun || status.running}
            >
              {status.running ? 'Backing up…' : 'Back up database'}
            </Button>
          </Flex>
        }
      />

      <Layouts.Content>
        <Flex direction="column" alignItems="stretch" gap={4}>
          {/* Server state, not a notice: the design-system Alert always renders a
              close button (closeLabel is required), and dismissing a condition
              that is still true would be a lie. */}
          {!status.configured && (
            <Banner tone="warning" title="Dropbox is not configured">
              Set DROPBOX_APP_KEY, DROPBOX_APP_SECRET and DROPBOX_REFRESH_TOKEN in the
              server&apos;s .env file and restart Strapi. See the plugin README for how to mint a
              refresh token.
            </Banner>
          )}

          {status.configured && !status.schedule && !status.mediaSchedule && (
            <Banner tone="neutral" title="No schedule">
              Both cron rules are empty, so backups only run when started from this page.
            </Banner>
          )}

          {status.running && (
            <Flex gap={2} alignItems="center">
              <Loader small>Backing up</Loader>
              <Typography textColor="neutral600">
                A backup is running. Media is fetched one file at a time, so this can take several
                minutes.
              </Typography>
            </Flex>
          )}

          {lastRun?.warnings?.length > 0 && dismissedWarningsFor !== lastRun.stamp && (
            <Alert
              title={`Last run reported ${lastRun.warnings.length} warning(s)`}
              variant="warning"
              closeLabel="Dismiss"
              onClose={() => setDismissedWarningsFor(lastRun.stamp)}
            >
              {lastRun.warnings.slice(0, 5).join(' · ')}
            </Alert>
          )}

          <Box background="neutral0" padding={0} hasRadius shadow="tableShadow">
            {runs.length === 0 ? (
              <Box padding={6}>
                <Typography textColor="neutral600">
                  No backups yet. {status.configured ? 'Start one above.' : ''}
                </Typography>
              </Box>
            ) : (
              <Table colCount={7} rowCount={runs.length}>
                <Thead>
                  <Tr>
                    <Th>
                      <Typography variant="sigma">When</Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">Result</Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">Scope</Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">Trigger</Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">Took</Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">Files</Typography>
                    </Th>
                    <Th>
                      <Typography variant="sigma">Pruned</Typography>
                    </Th>
                  </Tr>
                </Thead>
                <Tbody>
                  {runs.map((run) => (
                    <Tr key={run.stamp}>
                      <Td>
                        <Typography>{new Date(run.at).toLocaleString()}</Typography>
                      </Td>
                      <Td>
                        <Badge backgroundColor={run.ok ? 'success100' : 'danger100'}>
                          {run.ok ? 'OK' : 'Failed'}
                        </Badge>
                      </Td>
                      <Td>
                        <Flex direction="column" alignItems="start">
                          <Typography textColor="neutral600">
                            {run.includeMedia ? 'database + media' : 'database'}
                          </Typography>
                          {run.media && (
                            <Typography variant="pi" textColor="neutral500">
                              {`${run.media.uploaded} new, ${run.media.skipped} present`}
                              {run.media.failed ? `, ${run.media.failed} failed` : ''}
                              {run.media.timedOut ? ' (resumes next run)' : ''}
                            </Typography>
                          )}
                        </Flex>
                      </Td>
                      <Td>
                        <Typography textColor="neutral600">
                          {run.trigger}
                          {run.by ? ` · ${run.by}` : ''}
                        </Typography>
                      </Td>
                      <Td>
                        <Typography textColor="neutral600">
                          {formatDuration(run.durationMs)}
                        </Typography>
                      </Td>
                      <Td>
                        <Flex direction="column" alignItems="start">
                          {run.artifacts.map((artifact) => (
                            <Typography key={artifact.name} textColor="neutral600">
                              {artifact.name} ({formatBytes(artifact.bytes)})
                            </Typography>
                          ))}
                          {!run.ok && (
                            <Typography textColor="danger600">{run.error}</Typography>
                          )}
                        </Flex>
                      </Td>
                      <Td>
                        <Typography textColor="neutral600">
                          {run.prunedRuns ? `${run.prunedRuns} old run(s)` : '—'}
                        </Typography>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </Box>
        </Flex>
      </Layouts.Content>
    </Layouts.Root>
  );
};

export { HomePage };
