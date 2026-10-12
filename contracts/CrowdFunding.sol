// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract Crowdfunding is ReentrancyGuard {
    struct Campaign {
        address payable creator;
        string title;
        uint256 goal;        // wei
        uint256 deadline;    // unix 时间戳
        uint256 raised;
        bool withdrawn;
    }

    uint256 public campaignCount;
    mapping(uint256 => Campaign) public campaigns;
    mapping(uint256 => mapping(address => uint256)) public contributions;

    event CampaignCreated(uint256 indexed id, address indexed creator, string title, uint256 goal, uint256 deadline);
    event Contributed(uint256 indexed id, address indexed backer, uint256 amount);
    event Withdrawn(uint256 indexed id, address indexed creator, uint256 amount);
    event Refunded(uint256 indexed id, address indexed backer, uint256 amount);

    error InvalidInput();
    error CampaignNotFound();
    error CampaignEnded();
    error CampaignNotEnded();
    error GoalNotReached();
    error GoalReached();
    error NotCreator();
    error AlreadyWithdrawn();
    error NothingToRefund();
    error TransferFailed();

    modifier exists(uint256 id) {
        if (id >= campaignCount) revert CampaignNotFound();
        _;
    }

    function createCampaign(string calldata title, uint256 goal, uint256 durationMinutes) external returns (uint256 id) {
        if (bytes(title).length == 0 || bytes(title).length > 100) revert InvalidInput();
        if (goal == 0 || durationMinutes == 0 || durationMinutes > 129600) revert InvalidInput(); // 最长 90 天

        id = campaignCount++;
        uint256 deadline = block.timestamp + durationMinutes * 1 minutes;
        campaigns[id] = Campaign(payable(msg.sender), title, goal, deadline, 0, false);
        emit CampaignCreated(id, msg.sender, title, goal, deadline);
    }

    function contribute(uint256 id) external payable exists(id) {
        Campaign storage c = campaigns[id];
        if (block.timestamp >= c.deadline) revert CampaignEnded();
        if (msg.value == 0) revert InvalidInput();

        c.raised += msg.value;
        contributions[id][msg.sender] += msg.value;
        emit Contributed(id, msg.sender, msg.value);
    }

    function withdraw(uint256 id) external nonReentrant exists(id) {
        Campaign storage c = campaigns[id];
        if (msg.sender != c.creator) revert NotCreator();
        if (block.timestamp < c.deadline) revert CampaignNotEnded();
        if (c.raised < c.goal) revert GoalNotReached();
        if (c.withdrawn) revert AlreadyWithdrawn();

        c.withdrawn = true;                       // 先改状态
        uint256 amount = c.raised;
        (bool ok, ) = c.creator.call{value: amount}("");   // 后转账
        if (!ok) revert TransferFailed();
        emit Withdrawn(id, msg.sender, amount);
    }

    function refund(uint256 id) external nonReentrant exists(id) {
        Campaign storage c = campaigns[id];
        if (block.timestamp < c.deadline) revert CampaignNotEnded();
        if (c.raised >= c.goal) revert GoalReached();

        uint256 amount = contributions[id][msg.sender];
        if (amount == 0) revert NothingToRefund();

        contributions[id][msg.sender] = 0;        // 先清零
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Refunded(id, msg.sender, amount);
    }
}