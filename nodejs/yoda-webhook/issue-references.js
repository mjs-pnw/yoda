module.exports = {checkEvent, processIssueUrl};

var log4js = require('log4js');
var logger = log4js.getLogger();

const configuration = require('./configuration.js');
const yoda = require('./yoda-utils.js');
const yodaAppModule = require('./github-app.js');

const { Octokit } = require('@octokit/rest');

function authorizeUser() {
	// Set-up authentication
	var authString = "token " + configuration.getOption('password');
	const octokit = new Octokit({
		userAgent: 'yoda-webhook',
		baseUrl: configuration.getOption('baseurl'),
		log: logger,
		auth: authString
	});
	return octokit;
}

function authorize(payload) {
	if (configuration.getOption("app-mode")) {
		return yodaAppModule.authorize(payload);
	} else {
		return new Promise((resolve, reject) => {
			resolve(authorizeUser());
		});
	}
}

//getChildren function which will either get just from body or - if there is a "> issuesearch" clause do a search. Will return a promise.
function getChildren(octokit, ownRef, body) {
	return new Promise((resolve, reject) => {
		var children = yoda.getChildrenFromBody(ownRef, body);
		
		if (children.issueRefs.length > 0 && children.issueRefs[0].line != undefined && children.issueRefs[0].line.startsWith(configuration.getOption("issuesearch"))) {
			// Identify issues using a search criteria
			var searchExpr = children.issueRefs[0].line.substr(configuration.getOption("issuesearch").length);
			logger.debug("  Searching for issues using term: " + searchExpr);
			octokit.paginate(octokit.search.issuesAndPullRequests, {
				q: 'is:issue ' + searchExpr,
				sort: "created",
				order: "asc",
				per_page: 100 // per page, will will get all as using pagination
			}).then((issues) => {
				logger.info("  Found " + issues.length + " issues using searchExpr: " + searchExpr);
				logger.trace(issues);

				// Map searchResponse to children entries.
				// Remove all elements except the first (the "> issuesearch ..." line itself) AND any potential "> headline" lin~e
				if (children.issueRefs.length > 1 && children.issueRefs[1].line != undefined && children.issueRefs[1].line.startsWith(configuration.getOption("headline")))
					children.issueRefs.splice(2);
				else
					children.issueRefs.splice(1); 
				
				for (var i = 0; i < issues.length; i++) {
					var childRef = yoda.getRefFromUrl(issues[i].url);
					if (yoda.compareRefs(ownRef, childRef) != 0) {
						children.issueRefs.push(childRef);
					} else {
						logger.info("  Ignoring reference to self.");
					}
				}
				
				resolve(children);
			}).catch((err) => {
				// Insert error message in children
				children.issueRefs.splice(1, 0, {line: err.message});
				logger.error(err);
				resolve(children);
			});
		} else {
			// Normal case. No searching of issues. We have result immediately.
			resolve(children);
		}
	});
}


// Special case. Update child issue to indicate that the parentIssue indicate cannot be read... 
function updatePartOfRefNotThere(octokit, childRef, parentIssue) {
	logger.debug("updatePartOfRefNotThere: " + yoda.getFullRef(childRef) + " to indiciate that we cannot access " + yoda.getFullRef(parentIssue));
	
	// We need to get the issue again...
	octokit.issues.get(childRef).then((result) => {
		var parentRefs = yoda.getParentRefs(parentIssue, result.data.body);
		var parentIndex = yoda.findRefIndex(parentRefs, parentIssue);
	    var blockStart = parentRefs[parentIndex].index;
		var blockLength = parentRefs[parentIndex].length;
		var shortRef = yoda.getShortRef(childRef, parentIssue);
		var refLine = configuration.getOption("issueref") + " " + shortRef + " **Unable to get issue details - non-existing issue/access right problem?**";
		var newBody = result.data.body.slice(0, blockStart) + refLine + result.data.body.slice(blockStart + blockLength);

		var childUpdate = { owner: childRef.owner, repo: childRef.repo, issue_number: childRef.issue_number, body: newBody};
		octokit.issues.update(childUpdate).then((result) => {
			logger.info("  Updated parent reference in " + yoda.getFullRef(childRef) + " to indicated that we cannot find " + yoda.getFullRef(parentIssue));
		}).catch((err) => {
			logger.error(err);
		});
	}).catch((err) => {
		logger.error("  Failed to read issue " + yoda.getFullRef(childRef) + " in updatePartOfRefNotThere");
	});
}


// Update a chidl issue (as per childRef), ensuring correct pointer to parent issue 
// as given by parentIssue. childIssue contains the full (current) issue.
//Boolean includeOrExclude. Set to true to make sure to include, set to false to make sure to exclude
function updatePartOfRef(octokit, childRef, childIssue, parentIssue, includeOrExclude) {
	if (includeOrExclude)
		logger.debug("updatePartOfRef: " + yoda.getFullRef(childRef) + " to ensure pointing to " + parentIssue.url);
	else
		logger.debug("updatePartOfRef: " + yoda.getFullRef(childRef) + " to remove any pointer to " + parentIssue.url);
	
	var parentIssueRef = yoda.getRefFromUrl(parentIssue.url);
	var parentRefs = yoda.getParentRefs(parentIssueRef, childIssue.body);
	var parentIndex = yoda.findRefIndex(parentRefs, parentIssueRef);  
	
	var shortRef = yoda.getShortRef(childRef, parentIssueRef);
	var refLine = configuration.getOption("issueref") + " " + shortRef;
	var issueType = yoda.getMatchingLabels(parentIssue, configuration.getOption("labelre"));
	if (issueType != "")
		refLine += " " + issueType + " ";
	refLine += " *" + parentIssue.title.trim() + "*";
	logger.trace(refLine);
		
	var parentRefLine = configuration.getOption("issueref") + " ";
	var newBody = childIssue.body;
	if (parentIndex == -1) {
		if (includeOrExclude) {
			logger.debug("Issue reference not found. Inserting in beginning");
			newBody = refLine + "\n\n" + childIssue.body;
		}
	} else {
		logger.debug("Issue reference found.");
		logger.debug(parentRefs[parentIndex]);
		var blockStart = parentRefs[parentIndex].index;
		var blockLength = parentRefs[parentIndex].length;
		
		if (includeOrExclude) {
			newBody = childIssue.body.slice(0, blockStart) + refLine + childIssue.body.slice(blockStart + blockLength);
		} else {
			newBody = childIssue.body.slice(0, blockStart) + childIssue.body.slice(blockStart + blockLength);
		}
		
		// Check newBody for OTHER references TO THE SAME PARENT, i.e. not the first. If there, must be removed.
		var loopProt = 0; // Always wear protective gear
		do {
			loopProt++;
			var parentRefs = yoda.getParentRefs(parentIssueRef, newBody);
			var allParentIndex = yoda.findAllRefIndex(parentRefs, parentIssueRef);
			if ((includeOrExclude && allParentIndex.length > 1) || (!includeOrExclude && allParentIndex.length > 0)) {
				logger.info("  Removing extra partof reference in issue.");
				
				// Take last one out
				var blockStart = parentRefs[allParentIndex.slice(-1)].index;
				var blockLength = parentRefs[allParentIndex.slice(-1)].length;
				newBody = newBody.slice(0, blockStart) + newBody.slice(blockStart + blockLength);
			} else
				break;
		} while (true && loopProt < 100);
	}
	
	if (newBody != childIssue.body) {
		logger.debug("Updating child issue with correct parent reference. New length: " + newBody.length + ", old length: " + childIssue.body.length);
		
		// update it.
		var childUpdate = { owner: childRef.owner, repo: childRef.repo, issue_number: childRef.issue_number, body: newBody};
		octokit.issues.update(childUpdate).then((result) => {
			if (includeOrExclude) 
				logger.info("  Updated parent reference in " + yoda.getFullRef(childRef) + " to point to " + yoda.getFullRef(parentIssueRef));
			else 
				logger.info("  Updated parent reference in " + yoda.getFullRef(childRef) + " remove pointer to " + yoda.getFullRef(parentIssueRef));
		}).catch((err) => {
			logger.error(err);
		});
	} else {
		logger.debug("Child issue reference already correct. Skipping update..");
	}
}

// Boolean includeOrExclude. Set to true to make sure to include, set to false to make sure to exclude
function readSingleChildAndUpdatePartOf(octokit, issueRefs, index, parentIssue, includeOrExclude) {
	return new Promise((resolve, reject) => {
		logger.debug("Reading issue # " + index);
		// Let's see about getting the issue.
		octokit.issues.get(issueRefs[index]).then((result) => {
			logger.trace(result);
			issueRefs[index].issue = result.data;
			
			// Check/update > partof. NOte. we don't need to wait for the result here.
			updatePartOfRef(octokit, issueRefs[index], result.data, parentIssue, includeOrExclude);

			resolve();
		}).catch((err) => {
			logger.info("  Failed to read issue " + yoda.getFullRef(issueRefs[index]) + ", non-existing or insuffucient access rights?");
			logger.debug(err);
			issueRefs[index].issue = null;
			resolve();
		});
	});
}

//Helper function to query a list of issues, as given by their reference. The issue data will be populated in the issues field.
//If there is a problem, issue will be set to null, and a warning logger.
function readChildIssuesAndUpdatePartOf(octokit, childRefs, excludeChildRefs, parentIssue) {
	return new Promise((resolve, reject) => {
		var childPromises = [];
		for (var i = 0; i < childRefs.issueRefs.length; i++) {
			if (yoda.isRef(childRefs.issueRefs[i]))
				childPromises.push(readSingleChildAndUpdatePartOf(octokit, childRefs.issueRefs, i, parentIssue, true));
		}
		for (var i = 0; i < excludeChildRefs.length; i++) {
			if (yoda.isRef(excludeChildRefs[i]))
				childPromises.push(readSingleChildAndUpdatePartOf(octokit, excludeChildRefs, i, parentIssue, false));
		}

		// Wait for all children to complete reading and updating.
		Promise.all(childPromises).then(() => {
			logger.debug("Read all child issues.");
			resolve(childRefs);
		});
	});
}



//Furthermore, two lists can be supplied. A list of issues (by reference) that must present in the > contains list , and
//a list of issues by references that should NOT be present in same list (either because a > parent has been removed, or because
//one or more issues have been removed from the > subissues list.
function processIssueAsParent(octokit, issueRef, includeRefs, excludeRefs) {
	return new Promise((resolve, reject) => {
		logger.debug("Processing issue as parent: " + yoda.getFullRef(issueRef));
		
		// We will get the issue again to make sure we have a current picture. // TODO: Is this really always necessary. Need to analyze ... 
		octokit.issues.get(issueRef).then((response) => {
			logger.trace(response);
			getChildren(octokit, issueRef, response.data.body).then((children) => {
				logger.debug("Child references:");
				logger.debug(children);

				yoda.insertDeleteRefs(children, includeRefs, excludeRefs); 
				logger.debug("Adjusted child references:");
				logger.debug(children.issueRefs);

				// NOTE: Actually above use of excludeRefs is a bit silly. These issues will most likely already (not be) present in the body.
				// Instead we pass them on to the next step...

				// Now, lets read all issues that we are referring to... 
				readChildIssuesAndUpdatePartOf(octokit, children, excludeRefs, response.data).then((updatedChildren) => {
					logger.trace("Done reading and updating child issues");
					logger.trace(updatedChildren);

					// Now we are ready to update the issue itself
					// Note. Not waiting to complete.
					updateParentIssue(octokit, issueRef, updatedChildren, response.data); 

					resolve();
				});
			}).catch((err) => {
				logger.error(err);
				reject();
			});

		}).catch((err) => {
			logger.debug(err);
			// This is a bit tricky.... But overall, likely situation here is that we have been unable to read a > partof issue due to 
			// it being a non-existing issue and/or insufficient access rights.
			
			// Protect.
			if (includeRefs != undefined && includeRefs[0] != undefined)
				updatePartOfRefNotThere(octokit, includeRefs[0], issueRef);
			resolve();
		});
	});
}

//Here we'll update the a parent issue and it's children.
//ChildRefs is a structure containing the list of issue.
function updateParentIssue(octokit, issueRef, children, oldIssue) {
	logger.debug("updateParentIssue: " + yoda.getFullRef(issueRef) + " # of children: " + children.issueRefs.length);
	logger.debug(children);
//	logger.trace(oldIssue);

	var newBody = "";
	var blockStart = children.blockStart;
	var blockLength = children.blockLength;

	if (blockStart == -1) {
		if (yoda.noChildRefs(children.issueRefs) == 0) {
			logger.debug("No child block before and no issues now. Not doing anything..");
			return;
		}
	}

	// We need to make sure that issues are only present once.
	yoda.makeIssuesUnique(children);
	
	// Right, This is where we may have to consider if to make automatic headlines for the child issues. If so, we need to 
	// 1. Sort the issues so that the match the headlines
	// 2. Insert headlines as ".line" items. 
	// If we do those two things, we can let the remaining algorithm fill in the details for each issues as per normal.
	// Example: > headline ###,MS,P - Tentative,Q - NotCodeFreeze
	var hlLine = -1;
	if (children.issueRefs.length > 0 && children.issueRefs[0].line != undefined && children.issueRefs[0].line.startsWith(configuration.getOption("headline")))
		hlLine = 0;
	if (children.issueRefs.length > 1 && children.issueRefs[0].line != undefined && children.issueRefs[0].line.startsWith(configuration.getOption("issuesearch")) && children.issueRefs[1].line != undefined && children.issueRefs[1].line.startsWith(configuration.getOption("headline")))
		hlLine = 1;
	if (hlLine != -1) {
		var hlExpr = children.issueRefs[hlLine].line.substr(configuration.getOption("headline").length).trim();
		// If no expression is given, put the the default (we'll store it further down)
		if (hlExpr == "")
			hlExpr = configuration.getOption("headline-default");
		var hlParts = hlExpr.split(",");
		var prefix = hlParts[0];
		hlParts.splice(0, 1);
		var hlMilestone = false;
		if (hlParts[0] == configuration.getOption("headline-ms")) {
			hlMilestone = true;
			hlParts.splice(0, 1);
		}
		// hlParts now contains the labels.
		logger.debug(hlParts);
		logger.debug(hlParts.length);
		logger.debug("Headline format. Prefix: '" + prefix + "', includeMilestones: " + hlMilestone + ", labels: " + hlParts.join(","));
		
		if (hlMilestone)
			var allMilestones = yoda.getAllMilestones(children.issueRefs);
		else
			var allMilestones = [""];
		
		// Ok, time to take over and simply redo children.issueRefs. First into temporary area.
		// The headlines will be 
		var newIssueRefs = [];
		// First, keep > headline (and > issuessearch if there) lines as is. 
		for (var r = 0; r <= hlLine; r++)
			newIssueRefs.push(children.issueRefs[r]);
		newIssueRefs[hlLine].line = configuration.getOption("headline") + " " + hlExpr;
		
		// First, iterate milestons
		for (var m = 0; m < allMilestones.length; m++) {
			// Then we need to iterate all the labels in binary format (either they are there, or they are not). For this we could to 2^(# of labels)
			for (var labelOpt = 0; labelOpt < (1 << hlParts.length); labelOpt++) {
				// Ok, now we need to see if the relevant labels are set. 
				// Example: In or example value 0 means none of the two labels set, Value 1 means P - Tentative set, Value 2 means Q - No CodeFreeze set, Value 3 means both labels set.
				var header = prefix + allMilestones[m];
				var posLabels = [];
				var negLabels = [];
				for (var l = 0; l < hlParts.length; l++) {
					if (labelOpt & (1 << l)) 
						posLabels.push(hlParts[l]);
					else
						negLabels.push(hlParts[l]);
				}
				if (posLabels.length > 0)
					header += " [" + posLabels.join(",") + "]";
				if (posLabels.length == 0 && allMilestones[m] == "") 
					header = ""; // Special case. If not showing milestones, and no labels set, simply drop the header as this is the "base case";
				
				var noIssues = 0;
				// Now, let's add the matching issues.... Loop the issues.
				for (var r = hlLine + 1; r < children.issueRefs.length; r++) {
					// Right. IF the issue is a text item (could be e.g. one of the headlines we have added ourselves) we will simply skip it.
					if (children.issueRefs[r].line != undefined)
						continue;
					
					// Need to consider the case of non-existing issue. If we have this, then the issue will be null. In this case, what do we do? I think best to simply ignore it.
					if (children.issueRefs[r].issue == null)
						continue;
					
					// Does the issue belong in this section?
					// First check correct milestone (if showing milestones, consider "No Milestone")
					if (!(!hlMilestone || (children.issueRefs[r].issue.milestone == null && allMilestones[m] == "No Milestone") || 
							(children.issueRefs[r].issue.milestone != null && children.issueRefs[r].issue.milestone.title == allMilestones[m]))) 
						continue;
					
					// Then, consider labels.
					if (!yoda.labelListPos(children.issueRefs[r].issue, posLabels))
						continue;
					if (!yoda.labelListNeg(children.issueRefs[r].issue, negLabels))
						continue;
					
					if (noIssues == 0 && header != "") {
						// First issue in section, then we add the header.
						newIssueRefs.push({line: header});
					}
					newIssueRefs.push(children.issueRefs[r]);
					noIssues++;
				}
			}
		}
		
		// ok now let's "simply" replace our issue refs.
		children.issueRefs = newIssueRefs;
	}
	
	var block = yoda.makeChildBlock(issueRef, children);
	logger.debug("Block:");
	logger.debug(block); 

	logger.debug("BlockStart: " + blockStart + ", blockLength: " + blockLength);
	
	// Careful... we may not have an existing block! Note, that the block created will NOT have a newline at the end, so in order to force
	// a blank line, we add two newlines in this case.
	if (blockStart == undefined || blockStart == -1) {
		newBody = block + '\n\n' + oldIssue.body; 
		
	} else {
		newBody = oldIssue.body.slice(0, blockStart) + block + oldIssue.body.slice(blockStart + blockLength);		
	}
	
	logger.trace(newBody);

	issueRef.body = newBody;
	logger.debug("oldBody length: " + oldIssue.body.length + ", new length: " + newBody.length);

	if (oldIssue.body == newBody) {
		logger.info("  Skipping update as body is already correct for " + yoda.getFullRef(issueRef));
	} else {
		var update = { owner: issueRef.owner, repo: issueRef.repo, issue_number: issueRef.issue_number, body: newBody};

		octokit.issues.update(update).then((result) => {
			logger.info("  Updated child block in " + yoda.getFullRef(issueRef));
			logger.trace(result);
		}).catch((err) => {
			logger.error(err);
		});
	}
}

//Function/Loop to update structure. exclude boolean indicates if calling issue (issueRef) must be INCLUDED or EXCLUDED from the 
//child list (> contains list) into parent.
// Note: This is one way to use promises and sequentially execute list. TODO: Actually, this could be run in parallel...
function processParentRefIssues(octokit, issueRef, pList, exclude, index) {
	return new Promise(function(resolve, reject) {
		if (index == undefined)
			index = 0; // Let's get going...

		if (index < pList.length) {
			if (exclude) { 
				processIssueAsParent(octokit, pList[index], [], [issueRef]).then(() => {
					processParentRefIssues(octokit, issueRef, pList, exclude, index + 1).then(() => {
						resolve();
					});
				});
			}  else
				processIssueAsParent(octokit, pList[index], [issueRef], []).then(() => {
					processParentRefIssues(octokit, issueRef, pList, exclude, index + 1).then(() => {
						resolve();
					});
				});
		} else {
			resolve();
		}
	});
}

//This is the entry point for checking issues.
//The issue is assumed to be loaded and available in issue, coming either from a get call or the (new) issue part of an event.
function processIssue(octokit, issue) {
	return new Promise(function(resolve, reject) {
		var issueRef = yoda.getRefFromUrl(issue.url);
		// First handle issue as a child issue, i.e. examining any "> partof" lines, and doing appropriate updates to the referred parent issues.
		var parentRefs = yoda.getParentRefs(issueRef, issue.body);
		logger.debug("Parent references: ");
		logger.debug(parentRefs);
		processParentRefIssues(octokit, issueRef, parentRefs, false).then(() => {
			logger.debug("Done processing issues referenced by issue: " + issue.url);
			processIssueAsParent(octokit, issueRef, [], []).then(() => {
				logger.info("Done processing issue: " + issue.url);
				resolve();
			});
		}).catch((err) => {
			reject(err);
		});
	});
}

// Event hold
var eventHold = [];
// Check if we have done processing for this issue recently. If so, return null (and schedule an update)
function delayEvent(id, name, payload) {
	var issueUrl = payload.issue.url;

	// Do we already have the issue in the list? If so, clear previous timer.
	var i = eventHold.findIndex((element) => (element.url == issueUrl));
	if (i != -1)
		clearTimeout(eventHold[i].timeOut);

	logger.debug("Scheduling later execution for: " + issueUrl);
	timeOut = setTimeout(function() {
		// Remove element from list.
		var i = eventHold.findIndex((element) => (element.url == issueUrl));
		if (i != -1)
			eventHold.splice(i, 1);
					
		// Call to process the event, first marking that it comes via eventHold
		payload.eventHold = true;
		checkEvent(id, name, payload);	
	}, configuration.getOption('eventtimeout'));
	
	if (i ==-1)
		eventHold.push({url: issueUrl, timeOut: timeOut});
	else
		eventHold[i].timeOut = timeOut;
} 

//Main entry point for checking events.
function checkEvent(id, name, payload) {
	var issueUrl = payload.issue.url;
	var issueAction = payload.action;
	var issueRef = yoda.getRefFromUrl(issueUrl);

	if (payload.eventHold == undefined)
		logger.info("Checking issues event (" + issueAction + ") with id " + id + " by " + payload.sender.login + " for " + issueUrl);
	else
		logger.info("Resuming scheduled issue processing for event (" + issueAction + ") with id " + id + " by " + payload.sender.login + " for " + issueUrl);
	logger.trace(issueRef);
	logger.trace(payload);

	// We are really only interested in events which may have modified the body text, or state changes. 
	// Maybe as well labelled / unlabeled events as they could potentially be of interest (as some are listed in headline].. this can be debated, there are many such events.
	// NOTE: This should of course be adjusted if this service should perform other actions than parent/child issue references!
	// The possible issues actions are:
	// opened, edited, deleted, pinned, unpinned, closed, reopened, assigned, unassigned, labeled, unlabeled, locked, unlocked, transferred, milestoned, or demilestoned.
	var handleEventTypes = ['opened', 'edited', 'closed', 'reopened', 'labeled', 'unlabeled', "milestoned", "demilestoned"];
	if (handleEventTypes.indexOf(issueAction) == -1) {
		logger.info("  Disgarding event as not an event issue type (" + issueAction+ ") that we are interested in.");
		return;
	} 
	
	// First of, lets disgard events if they originate from us, i.e. the same user as used for doing the edit.
	// If running App mode, then we can identify based on presense of lack of [bot]
	if (issueAction == 'edited' && 
			((!configuration.getOption('app-mode') && payload.sender.login == configuration.getOption('user')) ||
			 (configuration.getOption('app-mode') && payload.sender.login.indexOf("[bot]") != -1))) {
		logger.info("  Disgarding event as looks like we initiated it.");
		return;
	} 
	
	// Let's worry about event hold here. Cannot ignore edited, don't hold if coming from scheduled execution, etc.
	if (payload.eventHold == undefined && !(issueAction == "edited" && payload.changes != undefined && payload.changes.body != undefined)) {
		// We will stop here for now. Event will be rescheduled in a while.
		logger.debug("  Delaying event for now.");
		delayEvent(id, name, payload);
		return;
	}

	logger.debug("  Event is of interest. Proceeding with processing.");
	
	// Authorize (user or GitHub App mode, then continue)
	authorize(payload).then((octokit) => {
		// Possible actions are: assigned, closed, deleted, demilestoned, edited, labeled, locked, milestoned, opened, pinned, reopened, transferred, unassigned, unlabeled, unlocked, unpinned
		// We will be potentially interested in any of them, just to make sure that we touch issues as and when appropriate.
		// For "edited" payload, we need to consider the old body text as well (in case an issue was removed either from "> parent" or "> subissues" section.
		if (issueAction == "edited" && payload.changes != undefined && payload.changes.body != undefined) {
			logger.trace("Found earlier body: " + payload.changes.body.from);

			// Handle deletions...... 
			var oldParentRefs = yoda.getParentRefs(issueRef, payload.changes.body.from);
			var newParentRefs = yoda.getParentRefs(issueRef, payload.issue.body);
			var deletedParentRefs = yoda.getRefsDiff(oldParentRefs, newParentRefs);
			logger.debug("deletedParentRefs:");
			logger.debug(deletedParentRefs);

			// Call to handle deletion of parents.
			processParentRefIssues(octokit, issueRef, deletedParentRefs, true).then(() => {
				// Any child deletions? Old children directly from body.
				var oldChildRefs = yoda.getChildrenFromBody(issueRef, payload.changes.body.from).issueRefs;

				// Get new children from new body (or issuesearch withint body), depending.
				getChildren(octokit, issueRef, payload.issue.body).then((newChildRefs) => {
					var deletedChildRefs = yoda.getRefsDiff(oldChildRefs, newChildRefs.issueRefs);
					logger.debug("deletedChildRefs. No of elements: " + deletedChildRefs.length);
					logger.debug(deletedChildRefs);

					processIssueAsParent(octokit, issueRef, [], deletedChildRefs).then(() => {
						logger.debug("Event - done with child deletions");
						processParentRefIssues(octokit, issueRef, newParentRefs, false).then(() => {
							logger.debug("Event - done with following parent refs.");
						});
						// ... Question is if we really need to call also processIssue again.. This would be for its potential role as a normal parent... I think we need to.
					});
				}).catch((err) => {
					logger.error(err);
				});
			});
		} else {
			// Not an edit event involving body. Normal processing.
			processIssue(octokit, payload.issue);
		}
	}).catch((err) => {
		logger.error(err);
	});
}

//Entry point for directly checking references based on input url
function processIssueUrl(url) {
	octokit = authorizeUser();

	logger.info("Retriving issue from url: " + url);

	// Get the full issue, then process
	var issueRef = yoda.getRefFromUrl(url);
	octokit.issues.get(issueRef).then((result) => {
		logger.trace(result);
		processIssue(octokit, result.data).then(() => {
			logger.info("Succesfully processes: " + url);
		});
	}).catch((err) => {
		logger.error("Could not retrieve issue from url: " + url + ", err: " + err);
	});
}
