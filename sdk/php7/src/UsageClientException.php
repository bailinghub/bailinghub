<?php
namespace Bailing\Connect;

/** Sanitized failure; an unknown write is retried only with the exact original request key. */
final class UsageClientException extends \RuntimeException
{
    public $usageCode;
    public $status;
    public $outcome;
    public $requestKey;
    public $feedback;

    public function __construct($code, $status, $outcome, $requestKey = null, array $feedback = array())
    {
        parent::__construct('Usage management request failed (' . $code . ').');
        $this->usageCode = $code;
        $this->status = $status;
        $this->outcome = $outcome;
        $this->requestKey = $requestKey;
        $this->feedback = $feedback;
    }
}
