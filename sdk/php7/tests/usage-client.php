<?php
require_once __DIR__ . '/../src/UsageClientException.php';
require_once __DIR__ . '/../src/UsageClient.php';
use Bailing\Connect\UsageClient;
use Bailing\Connect\UsageClientException;
function check($value) { if (!$value) throw new RuntimeException('Synthetic usage assertion failed'); }
$token = 'bhu_i_' . str_repeat('x', 43);
$calls = array();
$client = new UsageClient('https://hub.example.com', $token, 15, function ($method, $url, $headers, $body) use (&$calls, $token) {
    check(in_array('Authorization: Bearer ' . $token, $headers, true));
    $calls[] = array($method, parse_url($url, PHP_URL_PATH), $body === null ? null : json_decode($body, true));
    return array('status' => 200, 'body' => '{"ok":true}');
});
$input = array('request_key' => 'order-1', 'plan_id' => 'plan-1', 'expected_revision' => 0);
$client->exchangeSession(array('request_key' => 'login-1', 'tenant' => 'tenant-1', 'subject' => 'subject-1', 'service_id' => 'text'));
$client->grantBillingPlan('account-1', $input); $client->grantBillingPlan('account-1', $input);
$client->controlBillingPlan('account-1', array('request_key' => 'pause-1', 'expected_revision' => 1, 'state' => 'suspended'));
$client->getBillingSummary('account-1'); $client->revokeUser(array('tenant' => 'tenant-1', 'subject' => 'subject-1')); $client->listBillingPlans();
check(count($calls) === 7); check($calls[1][2] === $calls[2][2]);
check($calls[1][1] === '/usage/v1/external/billing/accounts/account-1/grant');
check($calls[4][1] === '/usage/v1/external/billing/accounts/account-1/summary');
check($calls[6][1] === '/usage/v1/external/billing/plans');
foreach (array('listTokenPlans', 'grantTokenPlan', 'controlTokenPlan', 'getTokenSummary', 'getSummary', 'putEntitlement', 'grantCredits', 'listLedger', 'listPlans') as $removed) check(!method_exists($client, $removed));
$renewal = array('request_key' => 'renewal-1', 'expected_revision' => 2, 'plan_id' => 'plan-1');
try { new UsageClient('https://hub.example.com', 'business-token'); throw new RuntimeException('must reject'); } catch (InvalidArgumentException $expected) {}
$attempts = 0;
$broken = new UsageClient('https://hub.example.com', $token, 15, function () use (&$attempts) { $attempts++; throw new RuntimeException('private URL or token'); });
try { $broken->grantBillingPlan('account-1', $input); throw new RuntimeException('must reject'); } catch (UsageClientException $error) {
    check($error->usageCode === 'USAGE_TRANSPORT_UNAVAILABLE'); check($error->outcome === 'unknown'); check($error->requestKey === 'order-1'); check(strpos($error->getMessage(), 'private') === false);
}
check($attempts === 1);
$renewalBodies = array();
$renewalClient = new UsageClient('https://hub.example.com', $token, 15, function ($method, $url, $headers, $body) use (&$renewalBodies) {
    check($method === 'POST'); check(substr($url, -6) === '/grant'); $renewalBodies[] = $body;
    if (count($renewalBodies) === 1) throw new RuntimeException('lost acknowledgement');
    return array('status' => 200, 'body' => '{"revision":3}');
});
try { $renewalClient->grantBillingPlan('account-1', $renewal); throw new RuntimeException('must reject'); } catch (UsageClientException $error) {
    check($error->outcome === 'unknown'); check($error->requestKey === 'renewal-1');
}
check(count($renewalBodies) === 1);
$renewed = $renewalClient->grantBillingPlan('account-1', $renewal);
check($renewed['revision'] === 3); check(json_decode($renewalBodies[0], true) === $renewal); check($renewalBodies[0] === $renewalBodies[1]);
$conflict = new UsageClient('https://hub.example.com', $token, 15, function () {
    return array('status' => 409, 'body' => '{"code":"USAGE_REVISION_CONFLICT","message":"private details","feedback":{"code":"USAGE_REVISION_CONFLICT","next_action":"refresh","token":"secret"}}');
});
try { $conflict->grantBillingPlan('account-1', $input); throw new RuntimeException('must reject'); } catch (UsageClientException $error) {
    check($error->usageCode === 'USAGE_REVISION_CONFLICT'); check($error->feedback['next_action'] === 'refresh'); check(!isset($error->feedback['token']));
}
$invalidResponses = array(
    array('', 200), array(" \n\t ", 200), array('nul', 200), array('{"incomplete":', 200),
    array('"null"', 200), array('false', 200), array('0', 200), array(str_repeat(' ', 1048576) . 'null', 200),
    array('null', 201), array('null', 401), array('null', 404), array('null', 500)
);
foreach ($invalidResponses as $response) {
    $attempts = 0;
    $invalid = new UsageClient('https://hub.example.com', $token, 15, function () use ($response, &$attempts) {
        $attempts++; return array('status' => $response[1], 'body' => $response[0]);
    });
    try { $invalid->getBillingSummary('account-1'); throw new RuntimeException('Invalid entitlement must reject'); } catch (UsageClientException $error) {
        check($error->usageCode === ($response[1] === 404 ? 'USAGE_UNSUPPORTED' : 'USAGE_RESPONSE_INVALID'));
        check($error->status === $response[1]); check($error->outcome === 'rejected');
    }
    check($attempts === 1);
}
$denied = new UsageClient('https://hub.example.com', $token, 15, function () { return array('status' => 403, 'body' => '{"code":"USAGE_IDENTITY_REVOKED"}'); });
try { $denied->getBillingSummary('account-1'); throw new RuntimeException('HTTP errors must reject'); } catch (UsageClientException $error) {
    check($error->usageCode === 'USAGE_IDENTITY_REVOKED'); check($error->outcome === 'rejected');
}
foreach (array('null', '', 'nul', str_repeat(' ', 1048576) . 'null') as $raw) {
    $attempts = 0;
    $invalid = new UsageClient('https://hub.example.com', $token, 15, function () use ($raw, &$attempts) { $attempts++; return array('status' => 200, 'body' => $raw); });
    try { $invalid->grantBillingPlan('account-1', $input); throw new RuntimeException('Mutation acknowledgement must reject'); } catch (UsageClientException $error) {
        check($error->usageCode === 'USAGE_RESPONSE_INVALID'); check($error->outcome === 'unknown'); check($error->requestKey === 'order-1');
    }
    check($attempts === 1);
}
echo "Usage issuer PHP synthetic checks passed, including malformed response boundaries\n";
