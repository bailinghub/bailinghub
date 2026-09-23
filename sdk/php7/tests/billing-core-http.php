<?php
// Synthetic loopback Core acceptance. Fixture credentials arrive over stdin, never command arguments.
require_once __DIR__ . '/../src/UsageClientException.php';
require_once __DIR__ . '/../src/UsageClient.php';
use Bailing\Connect\UsageClient;
use Bailing\Connect\UsageClientException;
function expectBilling($value) { if (!$value) throw new RuntimeException('Synthetic Core billing assertion failed'); }
function expectBillingError($code, $operation) {
    try { $operation(); } catch (UsageClientException $error) {
        expectBilling($error->usageCode === $code && $error->outcome === 'rejected'); return;
    }
    throw new RuntimeException('Expected synthetic Core billing rejection');
}
$fixture = json_decode(stream_get_contents(STDIN), true);
$client = new UsageClient($fixture['baseUrl'], $fixture['issuerToken']);
$identity = array('tenant' => 'synthetic-sdk', 'subject' => $fixture['subject']);
$loginInput = array_merge($identity, array('request_key' => $fixture['subject'], 'service_id' => $fixture['serviceId'], 'model_access' => 'token_gateway'));
$login = $client->exchangeSession($loginInput);
expectBilling($login['schema'] === 'bailing.usage-session.v1' && $login['session']['modelAccess'] === 'token_gateway');
expectBilling($client->exchangeSession($loginInput) == $login);
$accountId = $login['session']['accountId'];
$catalog = $client->listBillingPlans();
expectBilling(count($catalog['items']) === 2);
$byId = array(); foreach ($catalog['items'] as $plan) $byId[$plan['id']] = $plan;
expectBilling($byId[$fixture['periodPlanId']]['config']['priceUsd'] === 300);
expectBilling($byId[$fixture['periodPlanId']]['config']['periodAllowanceUsd'] === 100);
expectBilling(!isset($byId[$fixture['creditsPlanId']]['config']['periodAllowanceUsd']));
$before = $client->getBillingSummary($accountId);
expectBilling($before['grant'] === null && $before['presentation']['kind'] === 'none');
$grantInput = array('request_key' => 'grant-period', 'plan_id' => $fixture['periodPlanId'], 'expected_revision' => 0);
$grant = $client->grantBillingPlan($accountId, $grantInput);
expectBilling($client->grantBillingPlan($accountId, $grantInput) == $grant);
expectBilling($grant['sourceOwner'] === 'issuer:synthetic-product' && $grant['config']['periodAllowanceUsd'] === 100);
$summary = $client->getBillingSummary($accountId);
expectBilling($summary['schema'] === 'bailing.billing-summary.v1' && $summary['availableUsd'] === 100);
expectBilling($summary['consumedUsd'] === 0 && $summary['presentation']['kind'] === 'percentage');
expectBilling($summary['presentation']['remaining'] === 100 && $summary['plan']['multiplier'] === 1.5);
expectBillingError('USAGE_IDEMPOTENCY_CONFLICT', function () use ($client, $accountId, $grantInput) {
    $changed = $grantInput; $changed['expected_revision'] = 1; $client->grantBillingPlan($accountId, $changed);
});
expectBillingError('USAGE_REVISION_CONFLICT', function () use ($client, $accountId, $fixture) {
    $client->grantBillingPlan($accountId, array('request_key' => 'stale-grant', 'plan_id' => $fixture['periodPlanId'], 'expected_revision' => 0));
});
$pauseInput = array('request_key' => 'pause-period', 'expected_revision' => 1, 'state' => 'suspended');
$paused = $client->controlBillingPlan($accountId, $pauseInput);
expectBilling($paused['revision'] === 2 && $client->controlBillingPlan($accountId, $pauseInput) == $paused);
expectBilling($client->getBillingSummary($accountId)['presentation']['state'] === 'suspended');
$credits = $client->grantBillingPlan($accountId, array('request_key' => 'grant-credits', 'plan_id' => $fixture['creditsPlanId'], 'expected_revision' => 2));
expectBilling($credits['revision'] === 3);
$summary = $client->getBillingSummary($accountId);
expectBilling($summary['availableUsd'] === 12 && $summary['presentation']['displayValue'] === '12000');
$outsider = new UsageClient($fixture['baseUrl'], $fixture['outsiderToken']);
expectBillingError('USAGE_ACCOUNT_FORBIDDEN', function () use ($outsider, $accountId) { $outsider->getBillingSummary($accountId); });
expectBilling($client->revokeUser($identity)['revoked'] === true);
expectBilling($client->revokeUser($identity)['revoked'] === true);
expectBillingError('USAGE_ACCOUNT_SUSPENDED', function () use ($client, $loginInput) {
    $changed = $loginInput; $changed['request_key'] = 'after-revoke'; $client->exchangeSession($changed);
});
echo json_encode(array('accountId' => $accountId, 'grantId' => $credits['id'], 'revision' => $credits['revision'], 'checks' => 'passed'));
