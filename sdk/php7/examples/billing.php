<?php
require_once __DIR__ . '/../src/UsageClientException.php';
require_once __DIR__ . '/../src/UsageClient.php';

/** Invoke after authenticating a user in your own backend. Loading this file sends no requests. */
function prepareBillingPlan($baseUrl, $issuerToken, array $identity, $loginRequestKey, $serviceId, $planId, $orderRequestKey)
{
    $issuer = new \Bailing\Connect\UsageClient($baseUrl, $issuerToken);
    $login = $issuer->exchangeSession(array_merge($identity, array(
        'request_key' => $loginRequestKey, 'service_id' => $serviceId, 'model_access' => 'token_gateway'
    )));
    $accountId = $login['session']['accountId'];
    $summary = $issuer->getBillingSummary($accountId);
    // Persist this exact body with your order before calling grantBillingPlan.
    $grantInput = array('request_key' => $orderRequestKey, 'plan_id' => $planId,
        'expected_revision' => $summary['grant'] === null ? 0 : $summary['grant']['revision']);
    return array('credential' => $login['credential'], 'session' => $login['session'], 'accountId' => $accountId, 'grantInput' => $grantInput);
}

/** Submit the saved input, including its original revision. Do not prepare it again on retry. */
function applyBillingPlan($baseUrl, $issuerToken, $accountId, array $grantInput)
{
    $issuer = new \Bailing\Connect\UsageClient($baseUrl, $issuerToken);
    $issuer->grantBillingPlan($accountId, $grantInput);
    $summary = $issuer->getBillingSummary($accountId);
    return $summary['presentation'];
}
