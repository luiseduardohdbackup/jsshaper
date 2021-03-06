/*jshint globalstrict:true, eqeqeq:true, curly:true, latedef:true, newcap:true,
  undef:true, trailing:true */
/*global define:true, require:false, module:false, console:false, print:false */
if (typeof define !== 'function') { var define = require('amdefine')(module); }

define(['../../shaper', '../../ref', '../../narcissus', '../../tkn'],
       function(Shaper, Ref, Narcissus, tkn) {
"use strict"; "use restrict";

var log = (typeof console !== "undefined") && console.log || print;

// use a require('generator.js') in generated code, or assume that the
// global Generator has been defined?
var LOCAL_GENERATOR=false;

// converts functions containing yield/yield() to generators.
Shaper("yielder", function(root) {
    var allsyms = Object.create(null);
    var registersym = function(sym) {
        // add '$' to protect against built in object methods like
        // hasOwnProperty, etc.
        allsyms[sym+'$'] = true;
    };
    var gensym = (function(){
        var i = 0;
        return function(base) {
            var sym, first=true;
            base = base || 'tmp';
            do {
                // generate a new sym name, until it's actually unique...
                sym = '$'+base;
                if (first) {
                    first = false;
                } else {
                    sym += '$'+(i++);
                }
            } while ((sym+'$') in allsyms);
            registersym(sym);
            return sym;
        };
    })();
    var $Generator, $stop, $arguments, $pc, $ex, $val;

    function funcBodyStart(body, start_src) {
        start_src = start_src || '{';
        body.children = [];
        body.srcs = [start_src];
    }
    function funcBodyAdd(body, stmt, src) {
        if (Array.isArray(stmt)) {
            stmt.forEach(function(s, i) {
                funcBodyAdd(body, s, (i===(stmt.length-1))?src:'');
            });
        } else {
            body.children.push(stmt);
            body.srcs.push(src);
        }
    }
    function funcBodyAddComment(body, comment) {
        body.srcs[body.srcs.length-1] += comment;
    }
    function funcBodyFinish(body, close_src) {
        close_src = close_src || '}';
        body.srcs[body.srcs.length-1] += close_src;
    }

    var splitTokens = function(src, token) {
        var t = new Narcissus.lexer.Tokenizer(src);
        var i, tt, r=[], start=0;
        for (i=1; i<arguments.length; i++) {
            tt = t.mustMatch(arguments[i]);
            if (arguments[i]===tkn.END) { continue; }
            r.push(src.substring(start, tt.start));
            start = tt.end;
        }
        r.push(src.substring(start));
        return r;
    };
    var removeTokens = function(src, tokens) {
        return splitTokens.apply(this, arguments).join('');
    };
    var removeAllTokens = function(root) {
        var r = [];
        Shaper.traverse(root, {
            pre: function(node, ref) {
                if (node.leadingComment) {
                    r.push(node.leadingComment);
                }
                // grab newlines from srcs array; they might be slightly
                // misplaced (sigh)
                r.push(node.srcs.join('').replace(/\S/g,''));
            },
            post: function(node, ref) {
                if (node.trailingComment) {
                    r.push(node.trailingComment);
                }
            }
        });
        return r.join('');
    };
    var fixupJumps = function(fixups, labelEnd, this_target) {
        // fixup all break statements targetting this.
        for (var i=fixups.length-1; i>=0; i--) {
            var bf = fixups[i];
            if (arguments.length===2 || bf.target === this_target) {
                fixups.splice(i, 1);
                bf.ref.set(Shaper.parse(String(labelEnd)));
            }
        }
    };

    function YieldVisitor(props) {
        this.stack = [null];
        this.tryStack = [];
        this.breakFixup = [];
        this.continueFixup = [];
        this.newInternalCont();
        this.opt = [];
        this.scopeName = props.scopeName;
        this.finallyStack = [];
    }
    YieldVisitor.prototype = {
        top: function() { return this.stack[this.stack.length-1]; },
        add: function(child, src) {
            var top = this.top();
            funcBodyAdd(top.body, child, src);
        },
        addComment: function(comment) {
            var top = this.top();
            funcBodyAddComment(top.body, comment);
        },
        branchStmt: function(val) {
            if (typeof val === 'number') {
                val = String(val);
            }
            if (typeof val === 'string') {
                val = Shaper.parse(val);
            }
            // need to wrap the 'continue' in a throwaway while loop in order
            // to get it past the parser.
            var branchStmt = Shaper.replace('while(true){'+$pc+'=$;continue;}',
                                            val).body;
            branchStmt.children[1].expression.yielderSkip = true;
            return { stmt: branchStmt,
                     ref: new Ref(branchStmt.children[0].expression,
                                  'children', 1) };
        },
        optBranch: function(from, branchStmt) {
            this.opt.push({from: from,
                           to_ref:  branchStmt.ref,
                           cont:  branchStmt.stmt.children[1]});
        },
        addBranch: function(where) {
            if (!this.canFallThrough) {
                log("// Adding unreachable return");
            }
            var branchStmt = this.branchStmt(where);
            this.add(branchStmt.stmt.children, '');
            this.canFallThrough = false;
            this.optBranch(this.stack.length-1, branchStmt);
            return branchStmt;
        },
        close: function() {
            var top = this.top();
            if (!top) {
                this.stack.pop();
            } else {
                if (this.canFallThrough) {
                    this.add(Shaper.parse('throw '+$stop+';'), '');
                }
                funcBodyFinish(top.body);
            }
        },
        optimizeBranches: function() {
            this.opt.forEach(function(o) {
                var from = o.from;
                var to = o.to_ref.get();
                if (to.type!==tkn.NUMBER) { return; }
                to = to.value;
                if ((from+1) !== to) { return; }
                // remove the continue statement!
                o.cont.expression = null;
                o.cont.srcs = ['/*fall through*/'];
            });
        },
        currentTry: function() {
            for (var i=this.tryStack.length-1; i>=0; i--) {
                if (!this.tryStack[i].inCatch) {
                    return this.tryStack[i];
                }
            }
            return null;
        },
        currentCatch: function() {
            for (var i=this.tryStack.length-1; i>=0; i--) {
                if (this.tryStack[i].inCatch) {
                    return this.tryStack[i];
                }
            }
            return null;
        },

        newInternalCont: function() {
            this.close();

            var frame = Shaper.parse('switch(_){case '+this.stack.length+':{}}'
                                    ).cases[0];

            var new_top = { 'case': frame, body: frame.statements };

            // find active try block
            var tb = this.currentTry();
            if (tb) {
                var v = tb.varName;
                var tryBlock = Shaper.parse('try { $ } catch ('+v+') { }');
                funcBodyStart(new_top.body);
                funcBodyAdd(new_top.body, tryBlock, '');
                funcBodyFinish(new_top.body);
                new_top.body = tryBlock.tryBlock;

                // fill out catch block
                var c = tryBlock.catchClauses[0].block, s;
                funcBodyStart(c);

                // if exception caught, branch to catch or finally block
                s = Shaper.parse($ex+'={ex:'+v+'};');
                funcBodyAdd(c, s, '');
                s = this.branchStmt(-1);
                funcBodyAdd(c, s.stmt.children, '');
                this.optBranch(this.stack.length, s);
                // record fixup needed for catch block.
                tb.catchFixups.push(s);
                funcBodyFinish(c);
            }
            funcBodyStart(new_top.body);

            this.stack.push(new_top);
            this.canFallThrough = true;
        },
        newExternalCont: function(yieldVarName) {
            this.newInternalCont();
            this.add(Shaper.parse('if ('+$ex+') {throw '+$ex+'.ex;}'),
                     '');
            this.add(Shaper.parse(yieldVarName+'='+$val+';'), '');
        },

        visit: function(node, src) {
            this.canFallThrough = true;
            if (node.type in this) {
                return this[node.type].call(this, node, src);
            }
            console.assert(!node.isLoop);
            var wrapper = { node: node };
            var ref = new Ref(wrapper, 'node');
            ref.set(Shaper.traverse(node, this, ref));
            this.add(wrapper.node, src);
        },

        visitBlock: function(children, srcs) {
            var i;
            console.assert(children.length === srcs.length);
            children.forEach(function(child, i) {
                this.visit(child, srcs[i]);
            }.bind(this));
        },

        // rewrite arguments, catch expressions, var nodes, etc.
        pre: function(node, ref) {
            if (node.type === tkn.FUNCTION) {
                // if we are in a catch block, capture the scope.
                var tb = this.currentCatch();
                if (tb) {
                    var s = Shaper.parse('_=((function('+this.scopeName+
                                         '){return $;})('+this.scopeName+
                                         '));').expression.children[1];
                    s = Shaper.replace(s, node);
                    ref.set(s);
                }
                // skip nested functions.
                return "break";
            }
            if (node.type === tkn.VAR) {
                node.srcs[0] = removeTokens(node.srcs[0], tkn.VAR);
                node.type = tkn.COMMA;
            }
            if ((node.type === tkn.SEMICOLON &&
                 (node.expression.type === tkn.BREAK ||
                  node.expression.type === tkn.CONTINUE)) ||
                node.type === tkn.BREAK ||
                node.type === tkn.CONTINUE) {
                var leading='', trailing='';
                if (node.type === tkn.SEMICOLON) {
                    // eliminate upper SEMICOLON node; replace with BLOCK
                    leading = (node.leadingComment||'') +
                        node.srcs[0];
                    trailing= (node.trailingComment||'') +
                        removeTokens(node.srcs[1], tkn.SEMICOLON, tkn.END);
                    node = node.expression;
                }
                if (node.yielderSkip) {
                    // this is part of a generated branch sequence.
                    return "break";
                }
                // count how many finally blocks we're nested inside.
                var finallyCount = 0, firstFinally;
                for (var i=this.finallyStack.length-1; i>=0; i--) {
                    var f = this.finallyStack[i];
                    if (f['finally']) {
                        finallyCount++;
                        if (finallyCount===1 /* first */) {
                            firstFinally = f;
                        }
                    } else if (f.target===node.target) {
                        break;
                    }
                }
                var r = this.branchStmt(-1);
                var fixup = (node.type===tkn.BREAK) ?
                    this.breakFixup : this.continueFixup;
                if (finallyCount > 0) {
                    var ss=Shaper.parse($ex+'={fall:0,level:'+(finallyCount-1)+
                                        '};');
                    var fall = ss.expression.children[1].children[0];
                    fixup.push({ref:new Ref(fall, 'children', 1),
                                target: node.target});
                    fixup = firstFinally.fixups;
                    Shaper.insertBefore(new Ref(r.stmt, 'children', 0), ss, '');
                }
                fixup.push({ref:r.ref, target:node.target});
                // tweak comments.
                r.stmt.leadingComment = leading + (node.leadingComment||'');
                r.stmt.trailingComment = trailing + (node.trailingComment||'');

                if (node.label) {
                    var extra = removeTokens(node.srcs[0], node.type,
                                             tkn.IDENTIFIER, tkn.END);
                    r.stmt.trailingComment += extra;
                }
                this.canFallThrough = false;
                return ref.set(r.stmt);
            }
            if (node.type === tkn.RETURN) {
                this.canFallThrough = false;
                return ref.set(Shaper.parse('throw '+$stop));
            }
            if (node.type === tkn.THROW) {
                this.canFallThrough = false;
                // no other modification needed
                return;
            }
            if (node.type === tkn.YIELD) {
                var value;
                if (node.value) {
                    value = Shaper.traverse(node.value, this,
                                            new Ref(node, 'value'));
                } else {
                    value = Shaper.parse("void(0)");// 'undefined'
                }
                this.add(Shaper.parse($pc+'='+this.stack.length+';'));
                // need to wrap 'return' in a throwaway function in order
                // to get it past the parser.
                var rval = Shaper.parse('function _(){return $;}').
                    body.children[0];
                this.add(Shaper.replace(rval, value), '');
                this.canFallThrough=false;
                this.newExternalCont(node.yieldVarName);
                return ref.set(Shaper.parse(node.yieldVarName));
            }
        }
    };
    YieldVisitor.prototype[tkn.BLOCK] = function(node, src) {
        var leading = node.leadingComment || '';
        leading += removeTokens(node.srcs[0], tkn.LEFT_CURLY);
        var trailing = node.trailingComment || '';
        trailing += src;

        if (node.children.length===0) {
            // make a semicolon node, just to have a place to put the
            // comments.
            var semi = Shaper.parse(';');
            semi.leadingComment = removeTokens(leading, tkn.RIGHT_CURLY);
            this.add(semi, trailing);
            return;
        }

        // XXX could wrap '$block = Object.create($block);' and
        //     '$block = Object.getPrototypeOf($block);' around contents
        //     here to implement block scoping.

        // adjust comments.
        var new_srcs = node.srcs.slice(1);
        new_srcs[new_srcs.length-1] =
            removeTokens(new_srcs[new_srcs.length-1], tkn.RIGHT_CURLY) +
            trailing;
        node.children[0].leadingComment = leading +
            (node.children[0].leadingComment || '');
        // visit the statements, in turn.
        this.visitBlock(node.children, new_srcs);
    };
    YieldVisitor.prototype[tkn.LABEL] = function(node, src) {
        // transfer comments/whitespace around label
        var leading = (node.leadingComment || '') +
            (node._label.trailingComment || '');
        node.statement.leadingComment = leading +
            (node.statement.leadingComment || '');

        var this_target = node.statement;
        if (this_target.type===tkn.SEMICOLON) {
            this_target = this_target.expression;
        }
        this.finallyStack.push({target:this_target});
        this.visit(node.statement, src); // may mutate node.statement
        this.finallyStack.pop();

        var labelEnd = this.stack.length;
        if (this.canFallThrough) {
            this.addBranch(labelEnd);
        }
        this.newInternalCont();
        fixupJumps(this.breakFixup, labelEnd, this_target);
    };
    YieldVisitor.prototype[tkn.DO] = function(node, src) {
        node.condition = Shaper.traverse(node.condition, this,
                                          new Ref(node, 'condition'));
        var loopStart = this.stack.length;
        if (node.leadingComment) {
            this.addComment(node.leadingComment);
        }
        this.addBranch(loopStart);

        this.newInternalCont();

        this.finallyStack.push({target:node});
        this.visit(node.body, '');
        this.finallyStack.pop();


        var loopContinue = this.stack.length;
        if (this.canFallThrough) {
            this.addBranch(loopContinue);
        }
        this.newInternalCont();

        // bottom of loop: check the condition.
        var loopCheck = Shaper.parse("if ($) $");
        loopCheck.condition = node.condition;
        loopCheck.thenPart = this.branchStmt(loopStart).stmt;
        // transfer comments.
        loopCheck.srcs[0] = node.srcs[1].replace(/^while/, 'if');
        loopCheck.thenPart.trailingComment =
            removeTokens(src, tkn.RIGHT_PAREN, tkn.SEMICOLON, tkn.END);
        this.add(loopCheck, '');
        this.addBranch(this.stack.length);
        if (node.trailingComment) {
            this.addComment(node.trailingComment);
        }

        fixupJumps(this.breakFixup, this.stack.length, node);
        fixupJumps(this.continueFixup, loopContinue, node);
        this.newInternalCont();
    };
    YieldVisitor.prototype[tkn.WHILE] = function(node, src) {
        node.condition = Shaper.traverse(node.condition, this,
                                          new Ref(node, 'condition'));
        var loopStart = this.stack.length;
        this.addBranch(loopStart);
        this.newInternalCont();

        // top of loop: check the condition.
        var loopCheck = Shaper.parse("if (!($)) $");
        loopCheck.condition.children[0].children[0] = node.condition;
        var branchFixup = this.branchStmt(-1);
        loopCheck.thenPart = branchFixup.stmt;
        // transfer comments.
        Shaper.cloneComments(loopCheck, node);
        loopCheck.srcs[0] = node.srcs[0].replace(/^while/, 'if');
        this.add(loopCheck, '');

        this.finallyStack.push({target:node});
        this.visit(node.body, '');
        this.finallyStack.pop();

        if (this.canFallThrough) {
            this.addBranch(loopStart);
        }
        this.addComment(src);

        // fixup loop check
        fixupJumps([branchFixup], this.stack.length);
        fixupJumps(this.breakFixup, this.stack.length, node);
        fixupJumps(this.continueFixup, loopStart, node);
        this.newInternalCont();
    };
    YieldVisitor.prototype[tkn.FOR_IN] = function(node, src) {
        console.assert(false, "should have been removed in previous pass");
    };
    YieldVisitor.prototype[tkn.FOR] = function(node, src) {
        var setup;

        // fixup comments
        var extraComment = node.leadingComment || '';
        extraComment += node.srcs.slice(
            0, 1+(node.setup?1:0)+(node.condition?1:0)+(node.update?1:0)).
            join('');
        extraComment = removeTokens(extraComment, tkn.FOR, tkn.LEFT_PAREN);
        var split = splitTokens(extraComment, tkn.SEMICOLON,
                                tkn.SEMICOLON, tkn.RIGHT_PAREN,
                                tkn.END);
        this.addComment(split[0]);

        // if there is setup, emit it first.
        if (node.setup) {
            node.setup = Shaper.traverse(node.setup, this,
                                          new Ref(node, 'setup'));
            this.add(Shaper.replace('$;', node.setup), '');
        }
        this.addComment(split[1]);

        // now proceed like a while loop
        node.condition = Shaper.traverse(node.condition, this,
                                          new Ref(node, 'condition'));
        var loopStart = this.stack.length;
        this.addBranch(loopStart);
        this.newInternalCont();

        // top of loop: check the condition.
        var loopCheck = Shaper.parse("if (!($)) $");
        loopCheck.condition.children[0].children[0] = node.condition ||
            Shaper.parse('true');
        var branchFixup = this.branchStmt(-1);
        loopCheck.thenPart = branchFixup.stmt;
        loopCheck.thenPart.trailingComment = split[2] + split[3];
        if (node.condition) {
            this.add(loopCheck, '');
        } else {
            this.addComment(loopCheck.thenPart.trailingComment);
        }

        // loop body
        this.finallyStack.push({target:node});
        this.finallyStack.push({target:node.formerly||{}}); // converted for-in

        this.visit(node.body, '');

        this.finallyStack.pop();
        this.finallyStack.pop();

        // loop update
        var loopUpdate = this.stack.length;
        if (this.canFallThrough) {
            this.addBranch(loopUpdate);
        }
        this.newInternalCont();
        if (node.update) {
            node.update = Shaper.traverse(node.update, this,
                                          new Ref(node, 'update'));
            var update = Shaper.replace('$;', node.update);
            this.add(update, '');
        }
        this.addBranch(loopStart);
        if (node.trailingComment) {
            this.addComment(node.trailingComment);
        }
        this.addComment(src);

        // fixup loop check
        fixupJumps([branchFixup],this.stack.length);
        fixupJumps(this.breakFixup, this.stack.length, node);
        fixupJumps(this.continueFixup, loopUpdate, node);
        if (node.formerly) { // handle converted for-in loops
            fixupJumps(this.breakFixup, this.stack.length, node.formerly);
            fixupJumps(this.continueFixup, loopUpdate, node.formerly);
        }
        this.newInternalCont();
    };
    YieldVisitor.prototype[tkn.IF] = function(node, src) {
        node.condition = Shaper.traverse(node.condition, this,
                                          new Ref(node, 'condition'));
        var ifLoc = this.stack.length - 1, b;
        this.add(node, '');
        this.canFallThrough = false; // both sides of IF will get returns

        var thenPart = this.stack.length;
        this.newInternalCont();
        this.visit(node.thenPart, node.elsePart ? '' : src);
        var thenPlace = this.canFallThrough ?
            this.addBranch(this.stack.length) : null /*optimization*/;
        // replace original thenPart with branch to continuation
        b = this.branchStmt(thenPart);
        node.thenPart = b.stmt;
        this.optBranch(ifLoc, b);

        if (node.elsePart) {
            var elsePart = this.stack.length;
            this.newInternalCont();
            this.visit(node.elsePart, src);
            if (this.canFallThrough) {
                this.addBranch(this.stack.length);
            }
            // replace original elsePart with branch to continuation
            b = this.branchStmt(elsePart);
            node.elsePart = b.stmt;
            if (node.srcs[2].length===4) {
                node.srcs[2] += ' '; // ensure token separation
            }
            this.optBranch(ifLoc, b);
            // fixup then part
            if (thenPlace) {
                fixupJumps([thenPlace], this.stack.length);
            }
        } else {
            console.assert(node.srcs.length===3);
            node.elsePart = this.branchStmt(this.stack.length).stmt;
            node.srcs.splice(2, 0, ' else ');
        }
        this.newInternalCont();
    };
    YieldVisitor.prototype[tkn.SWITCH] = function(node, src) {
        var i, r;
        var s = Shaper.parse(node.switchVarName+' = $;');
        s = Shaper.replace(s, node.discriminant);
        if (node.leadingComment) { this.addComment(node.leadingComment); }
        this.addComment(removeTokens(node.srcs[0],
                                     tkn.SWITCH, tkn.LEFT_PAREN, tkn.END));
        this.add(s, '');
        r = this.addBranch(-1);
        this.addComment(removeTokens(node.srcs[1],
                                     tkn.RIGHT_PAREN, tkn.LEFT_CURLY, tkn.END));
        this.newInternalCont();
        this.finallyStack.push({target:node});

        var defaultLabel=null;
        var nextTest = [r], nextBody = [];

        node.cases.forEach(function(c, i) {
            var csrc = node.srcs[i+2];
            if (i===node.cases.length-1) {
                csrc = removeTokens(csrc, tkn.RIGHT_CURLY, tkn.END) + src;
            }
            if (c.leadingComment) { this.addComment(c.leadingComment); }
            if (c.type===tkn.DEFAULT) {
                defaultLabel = this.stack.length-1;
                this.addComment(removeTokens(c.srcs[0],
                                             tkn.DEFAULT, tkn.COLON, tkn.END));
            } else {
                // new case test
                fixupJumps(nextTest, this.stack.length-1);
                r = this.branchStmt(-1);
                nextBody.push(r);
                s = Shaper.parse('if ('+node.switchVarName+'===($)) $');
                s = Shaper.replace(s, c.caseLabel, r.stmt);
                this.addComment(removeTokens(c.srcs[0], tkn.CASE, tkn.END));
                this.add(s, removeTokens(c.srcs[1], tkn.COLON, tkn.END));

                // branch to next case test
                nextTest.push(this.addBranch(-1));

                this.newInternalCont();
            }
            fixupJumps(nextBody, this.stack.length-1);
            this.addComment(c.srcs[c.srcs.length-1]);
            // c.statements is a block w/o braces.  fixup before visiting.
            console.assert(c.statements.type===tkn.BLOCK);
            console.assert(c.statements.srcs.join('').indexOf('{')===-1);
            c.statements.srcs[0] = '{' + c.statements.srcs[0];
            c.statements.srcs[c.statements.srcs.length-1] += '}';
            this.visit(c.statements, csrc);

            if (this.canFallThrough) {
                // branch to next case body
                nextBody.push(this.addBranch(-1));
            }
            if (c.trailingComment) { this.addComment(c.trailingComment); }
            this.newInternalCont();
        }.bind(this));

        // default case.
        if (defaultLabel!==null) {
            fixupJumps(nextTest, defaultLabel);
        } else {
            fixupJumps(nextTest, this.stack.length-1);
        }

        // fall through; break
        fixupJumps(this.breakFixup, this.stack.length-1, node);
        fixupJumps(nextBody, this.stack.length-1);
        this.finallyStack.pop();
        if (node.trailingComment) { this.addComment(node.trailingComment); }
    };
    YieldVisitor.prototype[tkn.TRY] = function(node, src) {
        var c,i,j,s;
        if (node.leadingComment) {
            this.addComment(node.leadingComment);
        }
        this.addBranch(this.stack.length);

        var hasFinally = !!node.finallyBlock;
        var finallyFixups = [];
        var postTryFixups = [];
        var addFallThroughBranch;
        if (hasFinally) {
            this.tryStack.push({inCatch:false, isFinally:true,
                                varName: node.finallyVarName,
                                catchFixups: finallyFixups});
            // mark that we're entering a try block w/ a finally, so breaks
            // will unwind properly
            this.finallyStack.push({'finally':true, fixups:finallyFixups});
            addFallThroughBranch = function() {
                // level is 0 here because we're simply falling through
                // (not doing a non-local break)
                var s = Shaper.parse($ex+'={fall:0,level:0};');
                var fall = s.expression.children[1].children[0];
                postTryFixups.push({ref:new Ref(fall, 'children', 1)});
                this.add(s, '');
                finallyFixups.push(this.addBranch(-1));
            }.bind(this);
        } else {
            addFallThroughBranch = function() {
                // record fixup
                postTryFixups.push(this.addBranch(-1));
            }.bind(this);
        }

        for (i=node.catchClauses.length-1; i>=0; i--) {
            c = node.catchClauses[i];
            this.tryStack.push({varName:c.varName, inCatch:false,
                                catchFixups: []});
        }

        this.newInternalCont();
        this.visit(node.tryBlock, '');
        if (this.canFallThrough) {
            addFallThroughBranch();
        }

        // catch blocks
        node.catchClauses.forEach(function(cc, i) {
            var catchStart = this.stack.length;
            c = this.tryStack[this.tryStack.length-1];
            c.inCatch = true;
            fixupJumps(c.catchFixups, catchStart);

            this.newInternalCont();
            // bail if this is a stopiteration exception!
            s = Shaper.parse('if ('+$ex+'.ex==='+$stop+') '+
                             '{ throw '+$ex+'.ex; }');
            this.add(s, '');
            // create new scope
            s = Shaper.parse(this.scopeName+'=Object.create('+this.scopeName+
                             ');');
            this.add(s, '');
            // assign thrown exception to (renamed) variable in catch
            s = Shaper.parse(cc.yieldVarName+' = '+$ex+'.ex;');
            Shaper.cloneComments(s, cc._name);
            var extra = (cc.leadingComment||'') +
                removeTokens(cc.srcs[0], tkn.CATCH, tkn.LEFT_PAREN);
            s.leadingComment = extra + (s.leadingComment||'');
            this.add(s, '');

            // create new try/finally block to ensure that every exit from
            // cc.block will pop the scope.
            s = Shaper.parse('try {} finally { '+
                             this.scopeName+'=Object.getPrototypeOf('+
                             this.scopeName+'); }');
            s.tryBlock = cc.block;
            s.finallyVarName = cc.finallyVarName;
            this.visit(s, '');

            if (this.canFallThrough) {
                addFallThroughBranch();
            }
            this.tryStack.pop();
        }.bind(this));

        // after try / finally
        var finallyLabel = this.stack.length;
        fixupJumps(finallyFixups, finallyLabel);
        if (hasFinally) {
            this.tryStack.pop();
            this.finallyStack.pop();
            this.newInternalCont();
            this.add(Shaper.parse(node.finallyVarName+' = '+$ex+';'), '');

            this.canFallThrough = true;
            this.visit(node.finallyBlock, '');

            if (this.canFallThrough) {
                // throw, or jump from finally block to fall through or break
                s = Shaper.parse('if ('+node.finallyVarName+'.fall) {'+
                                 '}else{throw '+node.finallyVarName+'.ex;}');
                var gotoFall =
                    this.branchStmt(Shaper.parse(node.finallyVarName+'.fall')).
                    stmt;
                // is there a surrounding finally?
                var nextFinally;
                for (i=this.finallyStack.length-1; i>=0; i--) {
                    if (this.finallyStack[i]['finally']) {
                        nextFinally = this.finallyStack[i];
                        break;
                    }
                }
                if (nextFinally) {
                    var ss = Shaper.parse('{if('+node.finallyVarName+'.level){'+
                                          node.finallyVarName+'.level--;'+
                                          $ex+'='+node.finallyVarName+';'+
                                          '$'+
                                          '} else $}');
                    var b = this.branchStmt(-1);
                    nextFinally.fixups.push(b);
                    ss = Shaper.replace(ss, b.stmt, gotoFall);
                    this.optBranch(this.stack.length-1, b);
                    s.thenPart = ss;
                } else {
                    s.thenPart = gotoFall;
                }
                this.add(s, '');
                this.canFallThrough = false;
            }
        } else {
            console.assert(finallyFixups.length===0);
        }

        // after try
        fixupJumps(postTryFixups, this.stack.length);

        this.newInternalCont();
        if (node.trailingComment) {
            this.addComment(node.trailingComment);
        }
        this.addComment(src);
    };

    function rewriteGeneratorFunc(node, props, ref) {
        var stmts = [];
        var i;
        // export the Generator and StopIteration
        if (LOCAL_GENERATOR) {
            stmts.push(Shaper.parse('var '+$Generator+
                                    ' = require("generator.js");'));
        }
        stmts.push(Shaper.parse('var '+$pc+' = 0;'));
        if (props.vars.length > 0) {
            stmts.push(Shaper.parse("var "+props.vars.join(',')+";"));
        }
        if (props['arguments']) {
            stmts.push(Shaper.parse('var '+$arguments+' = arguments;'));
        }
        if (props.scopeName) {
            stmts.push(Shaper.parse('var '+props.scopeName+'=Object.create(null);'));
        }
        var body = node.body;
        if (body.type === tkn.GENERATOR) {
            // Narcissus started adding an extra node here in commit 82c9b732
            body = body.body;
        }
        var yv = new YieldVisitor(props);
        console.assert(body.children.length > 0);
        // first and last body.srcs elements stay with outer function.
        var old_srcs = body.srcs;
        var inner_srcs = old_srcs.slice(1, old_srcs.length-1);
        inner_srcs.push('');

        // check first send.
        yv.add(Shaper.parse('if('+$ex+'||('+$val+'!==void(0))){'+
                            'throw new TypeError();'+
                            '}'), '');
        // translate function
        yv.visitBlock(body.children, inner_srcs);
        yv.close();
        yv.optimizeBranches();

        var s = Shaper.parse('_=function('+$stop+','+$ex+','+$val+'){'+
                             'while(true){'+
                             'switch('+$pc+'){'+
                             '}}}').children[1];
        var sw = s.body.children[0].body.children[0];
        sw.cases = yv.stack.map(function(c) { return c['case']; });
        sw.srcs[1]='){';
        yv.stack.forEach(function(e){ sw.srcs.push(''); });
        sw.srcs[sw.srcs.length-1]+='}';
        sw.cases.forEach(function(c) {
            var srcs = c.statements.srcs;
            srcs[0] = removeTokens(srcs[0],tkn.LEFT_CURLY);
            srcs[srcs.length-1] = removeTokens(srcs[srcs.length-1],
                                               tkn.RIGHT_CURLY);
        });

        // Note that we need to make a bogus function wrapper here or else
        // parse() will complain about the 'return outside of a function'
        var newBody = Shaper.replace(
            'function _(){return new '+$Generator+'($.bind(this));}',
            s).body.children[0];
        stmts.push(newBody);

        // hollow out old function and replace it with new function body
        funcBodyStart(body, old_srcs[0]);
        stmts.forEach(function(stmt) {
            funcBodyAdd(body, stmt, '');
        });
        funcBodyFinish(body, old_srcs[old_srcs.length-1]);

        return node;
    }

    // rewrite "short function literal" syntax
    root = Shaper.traverse(root, {
        post: function(node, ref) {
            if (node.type === tkn.FUNCTION &&
                node.body.type !== tkn.SCRIPT &&
                node.body.type !== tkn.GENERATOR) {
                var s = Shaper.parse("_=function(){return $;}")
                    .children[1].body;
                s = Shaper.replace(s, node.body);
                node.body = s;
            }
        }
    });

    // rewrite generator expressions and array comprehensions
    root = Shaper.traverse(root, {
        generator: function(node) {
            var forLoop = node.tail.children[0];
            var guard = node.tail.guard || Shaper.parse('true');
            var s = Shaper.parse('(function(){'+
                                 'var '+forLoop.iterator.name+';'+
                                 '$})()');
            s = Shaper.replace(s, forLoop);
            Shaper.cloneComments(s, node);

            var y = Shaper.parse('function _(){if ($) yield ($);}').
                body.body.children[0];
            forLoop.body = Shaper.replace(y, guard, node.expression);

            // _iterator is not/no longer a varDecl.
            forLoop._iterator = Shaper.parse(forLoop.iterator.name);
            delete forLoop.varDecl;

            // have to fix up forLoop's srcs array, weird
            var src = splitTokens(forLoop.srcs[0], tkn.FOR);
            var src0 = (node.tail.leadingComment||'')+src[0]+'for ';
            if (forLoop.isEach) {
                src = splitTokens(src[1], tkn.IDENTIFIER/*each*/);
                src0 += src[0]+'each ';
            }
            src = removeTokens(src[1], tkn.LEFT_PAREN, tkn.IDENTIFIER);
            src0 += '(';
            forLoop.srcs.splice(0, 1, src0, src);
            forLoop.srcs.push('');
            return s;
        },
        post: function(node, ref) {
            var s;
            if (node.type === tkn.ARRAY_COMP) {
                s = Shaper.parse('(($).toArray())');
                s = Shaper.replace(s, this.generator(node));
                return ref.set(s);
            }
            if (node.type === tkn.GENERATOR &&
                !(ref.base.type === tkn.FUNCTION &&
                  ref.properties[0] === 'body')) {
                s = Shaper.parse('($)');
                s = Shaper.replace(s, this.generator(node));
                return ref.set(s);
            }
        }
    });

    // find functions containing 'yield' and take note of uses of
    // 'arguments' and 'catch' as well.  Register all symbols so that
    // gensym is guaranteed to be safe.
    var yieldfns = [];
    root = Shaper.traverse(root, {
        fns: [{fake:true,vars:[],caught:[]}],
        pre: function(node, ref) {
            var i;
            if (node.type === tkn.FUNCTION) {
                this.fns.push({node: node, ref: ref, vars: [], caught: [],
                               'yield': false, 'arguments': false,
                               'catch': false, 'finally': false});
                node.params.forEach(function(p) {
                    registersym(p);
                });
            }
            var fn = this.fns[this.fns.length-1];
            if (node.type === tkn.YIELD) {
                if (fn.fake) {
                    Shaper.error(node, "yield outside function");
                } else {
                    fn['yield'] = true;
                }
            }
            if (node.type === tkn.VAR) {
                node.children.forEach(function(child) {
                    if (child.type===tkn.ASSIGN) {
                        child = child.children[0];
                    }
                    console.assert(child.type===tkn.IDENTIFIER);
                    fn.vars.push(child.value);
                    registersym(child.value);
                });
            }
            if (node.type === tkn.CATCH) {
                fn['catch'] = true;
                fn.caught.push(node.varName);
                registersym(node.varName);
            }
            if (node.type === tkn.TRY && node.finallyBlock) {
                fn['finally'] = true;
            }
            if (node.type === tkn.IDENTIFIER && node.value === 'arguments') {
                // a bit conservative:: you might have defined your own
                // variable named arguments, etc.  no worries.
                fn['arguments'] = true;
            }
            if (node.type === tkn.IDENTIFIER) {
                // again conservative: gets property and label names, too.
                registersym(node.value);
            }
        },
        post: function(node, ref) {
            var fn;
            if (node.type === tkn.FUNCTION) {
                fn = this.fns.pop();
                fn.node.yield_info = fn;
                if (fn['yield']) {
                    yieldfns.push(fn);
                }
            }
        }
    });

    // gensym
    $stop = gensym('stop');
    $arguments = gensym('arguments');
    $pc = gensym('pc');
    $ex = gensym('ex');
    $val = gensym('val');
    if (LOCAL_GENERATOR) {
        $Generator = gensym('Generator');
    } else {
        $Generator = "Generator";
    }

    // rewrite for-in loops
    root = Shaper.traverse(root, {
        post: function(node, ref) {
            if (node.type === tkn.FOR_IN) {
              // convert to use iterator
              var it = gensym('it'), e = gensym('e');
              var param=(node.isEach ? "false,true" : "true");
              var newFor = Shaper.replace('for(var '+it+'=Iterator($,'+param+');;){'+
                                          'try { $='+it+'.next(); } '+
                                          'catch ('+e+') { '+
                                          'if ('+e+'===StopIteration) break; '+
                                          'throw '+e+'; }'+
                                          '$}',
                                          node.object,
                                          node.varDecl || node._iterator,
                                          node.body);
              newFor.labels = node.labels;
              Shaper.cloneComments(newFor, node);
              newFor.srcs[0] = node.srcs[0];
              if (node.isEach) {
                  newFor.srcs[0] = 'for' +
                      removeTokens(node.srcs[0], tkn.FOR,
                                   tkn.IDENTIFIER/*each*/);
              }
              newFor.srcs[1] =
                  removeTokens(node.srcs[1], tkn.IN, tkn.END) +
                  newFor.srcs[1] +
                  removeTokens(node.srcs[2], tkn.RIGHT_PAREN, tkn.END);
              newFor.srcs[2] = node.srcs[3];
              newFor.formerly = node; // for matching up break/continue
              // looks better if we move the trailing comment from the old body
              // to the new body
              var trailing = node.body.trailingComment || '';
              delete node.body.trailingComment;
              newFor.body.trailingComment = trailing +
                  (newFor.body.trailingComment || '');
              return ref.set(newFor);
          }
        }
    });

    // rewrite 'function foo(...)' to 'var foo = function(...)'
    // DO THIS GLOBALLY (not just inside generators).
    // THIS ALTERS THE SEMANTICS OF THE LANGUAGE.
    // See https://bugs.webkit.org/show_bug.cgi?id=65546 and
    //     https://bugs.webkit.org/show_bug.cgi?id=27226
    // We need to hoist the scope of the function declaration to make
    // the generator work; the question is whether to attempt to
    // move the entire function declaration (as webkit does) or just
    // do the 'function foo' -> 'var foo = function' transformation
    // (as mozilla does) which postpones the definition of foo until
    // the assignment statement is executed.
    // Since the rest of the yielder code is basically making webkit
    // "more like JavaScript 1.7" (yield, generators, and iterators)
    // it makes sense to just do the 'function foo' -> 'var foo = function'
    // transformation to make this aspect of the semantics the same as
    // JavaScript 1.7 as well, rather than to jump through hoops to try
    // to preserve the arguably-broken-but-unfixable webkit semantics.
    // If we're going to make this change, we're going to make it globally,
    // so that we don't have one behavior inside generators and
    // a different one outside.
    root = Shaper.traverse(root, {
        func_stack: [{func:root, hoist:[]}],
        pre: function(node, ref) {
            if (node.type === tkn.FUNCTION) {
                this.func_stack.push({func: node, hoist:[]});
            }
        },
        post: function(node, ref) {
            var f,i,s;
            if (node.type === tkn.FUNCTION) {
                f = this.func_stack.pop();
                // hoist any of this function's children who need it.
                var hfunc = [];
                for (i=f.hoist.length-1; i>=0; i--) {
                    var sref = f.hoist[i];
                    s = sref.get();
                    // grab the 'src' which is about to be deleted by .remove()
                    // (this logic is copied from the Shaper.remove())
                    var index = Number(sref.properties[1]);
                    var len = sref.base[sref.properties[0]].length;
                    if (index !== (len-1)) {
                        index++;
                    }
                    var src = (len===1)?'':sref.base.srcs[index];
                    // remove the statement from its old location
                    Shaper.remove(sref);
                    // add it to the top of the function.
                    hfunc.push([s, src]);
                }
                hfunc.forEach(function(ss) {
                    Shaper.insertBefore(new Ref(node.body, 'children', 0),
                                        ss[0], ss[1]);
                });
                var parent = this.func_stack[this.func_stack.length-1];
                if (ref.base === root) {
                    /* leave top level decls alone */
                    return;
                }
                if (ref.base.type===tkn.SCRIPT ||
                    ref.base.type===tkn.BLOCK) {
                    // function statement (not a function expression)
                    // rewrite as 'var ... = function ...'
                    var name = node.name || gensym('f');
                    s = Shaper.replace(Shaper.parse('var '+name+' = $;'),
                                       node);
                    // move leading and trailing comments (this avoids a
                    // bad line break after 'var <name>'!)
                    Shaper.cloneComments(s, node);
                    delete node.leadingComment;
                    delete node.trailingComment;
                    if (ref.base === parent.func.body) {
                        // for top-level function statements, mark them
                        // for hoisting to the top of the function.
                        parent.hoist.push(ref);
                    }
                    return ref.set(s);
                }
            }
        }
    });
    // rewrite catch variables and 'arguments'; assign temps to 'yield's
    root = Shaper.traverse(root, {
        func_stack: [{yield_info:{}}],
        varenv: {
            env: Object.create(null),
            push: function() { this.env = Object.create(this.env); },
            pop: function() { this.env = Object.getPrototypeOf(this.env); },
            remove: function(v) { this.env[v+'$'] = false; },
            put: function(v, nv) { this.env[v+'$'] = nv; },
            has: function(v) { return !!this.env[v+'$']; },
            get: function(v) { return this.env[v+'$']; }
        },
        current_func: function() {
            return this.func_stack[this.func_stack.length-1];
        },
        pre: function(node, ref) {
            if (node.type===tkn.FUNCTION) {
                this.func_stack.push(node);
                // remove mappings for 'var' and function parameters
                this.varenv.push();
                // var-bound variables
                node.yield_info.vars.forEach(function(v) {
                    this.varenv.remove(v);
                }.bind(this));
                // function parameters
                node.params.forEach(function(v) {
                    this.varenv.remove(v);
                }.bind(this));
                // if this is a generator, add new name for 'arguments'
                if (node.yield_info['yield']) {
                    this.varenv.put('arguments', $arguments);
                } else {
                    this.varenv.remove('arguments');
                }
            }
            var yi = this.current_func().yield_info;
            if (node.type===tkn.DOT) {
                // only traverse 1st child; second is not an expression
                Shaper.traverse(node.children[0], this,
                                new Ref(node, 'children', 0));
                return "break";
            }
            if (node.type===tkn.LABEL) {
                // only traverse statement; label is not a name.
                Shaper.traverse(node.statement, this,
                                new Ref(node, 'statement'));
                return "break";
            }
            if (node.type===tkn.PROPERTY_INIT) {
                // only traverse 2nd child; first is not an expression
                Shaper.traverse(node.children[1], this,
                                new Ref(node, 'children', 1));
                return "break";
            }
            if (node.type===tkn.IDENTIFIER) {
                if (ref.base.type===tkn.CATCH &&
                    ref.properties[0]==='_name') {
                    // don't rewrite the actual catch varName
                    return "break";
                } else if (this.varenv.has(node.value)) {
                    ref.set(Shaper.parse(this.varenv.get(node.value)));
                    return "break";
                }
            }
            if (node.type===tkn.CATCH) {
                this.varenv.push();
                if (yi['yield']) {
                    // catch inside a generator!
                    if (!yi.scopeName) {
                        yi.scopeName = gensym('scope');
                    }
                    // add this to the environment
                    node.yieldVarName = yi.scopeName+'.'+node.varName;
                    this.varenv.put(node.varName, node.yieldVarName);
                    // we'll be generating a finally block to free the scope
                    node.finallyVarName = gensym('finally');
                    yi.vars.push(node.finallyVarName);
                } else if (this.varenv.has(node.varName)) {
                    // this catch shadows a previously-caught variable;
                    // remove it from the environment.
                    this.varenv.remove(node.varName);
                }
            }
            if (node.type===tkn.TRY) {
                if (yi['yield']) {
                    // we always add a finally block to clean up the scope,
                    // whether or not the try actually had one.
                    node.finallyVarName = gensym('finally');
                    yi.vars.push(node.finallyVarName);
                }
            }
            if (node.type===tkn.YIELD) {
                node.yieldVarName = gensym('yield');
                yi.vars.push(node.yieldVarName);
            }
            if (node.type===tkn.SWITCH) {
                if (yi['yield']) {
                    node.switchVarName = gensym('switch');
                    yi.vars.push(node.switchVarName);
                }
            }
        },
        post: function(node, ref) {
            if (node.type===tkn.FUNCTION) {
                this.func_stack.pop();
            }
            if (node.type===tkn.FUNCTION || node.type===tkn.CATCH) {
                // pop caught variables off the scope.
                this.varenv.pop();
            }
        }
    });
    // rewrite generator functions
    yieldfns.forEach(function(yieldfn) {
        rewriteGeneratorFunc(yieldfn.node, yieldfn, yieldfn.ref);
    });
    return root;
});

    return Shaper.get("yielder");
});
