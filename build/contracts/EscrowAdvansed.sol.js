var Web3 = require("web3");
var SolidityEvent = require("web3/lib/web3/event.js");

(function() {
  // Planned for future features, logging, etc.
  function Provider(provider) {
    this.provider = provider;
  }

  Provider.prototype.send = function() {
    this.provider.send.apply(this.provider, arguments);
  };

  Provider.prototype.sendAsync = function() {
    this.provider.sendAsync.apply(this.provider, arguments);
  };

  var BigNumber = (new Web3()).toBigNumber(0).constructor;

  var Utils = {
    is_object: function(val) {
      return typeof val == "object" && !Array.isArray(val);
    },
    is_big_number: function(val) {
      if (typeof val != "object") return false;

      // Instanceof won't work because we have multiple versions of Web3.
      try {
        new BigNumber(val);
        return true;
      } catch (e) {
        return false;
      }
    },
    merge: function() {
      var merged = {};
      var args = Array.prototype.slice.call(arguments);

      for (var i = 0; i < args.length; i++) {
        var object = args[i];
        var keys = Object.keys(object);
        for (var j = 0; j < keys.length; j++) {
          var key = keys[j];
          var value = object[key];
          merged[key] = value;
        }
      }

      return merged;
    },
    promisifyFunction: function(fn, C) {
      var self = this;
      return function() {
        var instance = this;

        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {
          var callback = function(error, result) {
            if (error != null) {
              reject(error);
            } else {
              accept(result);
            }
          };
          args.push(tx_params, callback);
          fn.apply(instance.contract, args);
        });
      };
    },
    synchronizeFunction: function(fn, instance, C) {
      var self = this;
      return function() {
        var args = Array.prototype.slice.call(arguments);
        var tx_params = {};
        var last_arg = args[args.length - 1];

        // It's only tx_params if it's an object and not a BigNumber.
        if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
          tx_params = args.pop();
        }

        tx_params = Utils.merge(C.class_defaults, tx_params);

        return new Promise(function(accept, reject) {

          var decodeLogs = function(logs) {
            return logs.map(function(log) {
              var logABI = C.events[log.topics[0]];

              if (logABI == null) {
                return null;
              }

              var decoder = new SolidityEvent(null, logABI, instance.address);
              return decoder.decode(log);
            }).filter(function(log) {
              return log != null;
            });
          };

          var callback = function(error, tx) {
            if (error != null) {
              reject(error);
              return;
            }

            var timeout = C.synchronization_timeout || 240000;
            var start = new Date().getTime();

            var make_attempt = function() {
              C.web3.eth.getTransactionReceipt(tx, function(err, receipt) {
                if (err) return reject(err);

                if (receipt != null) {
                  // If they've opted into next gen, return more information.
                  if (C.next_gen == true) {
                    return accept({
                      tx: tx,
                      receipt: receipt,
                      logs: decodeLogs(receipt.logs)
                    });
                  } else {
                    return accept(tx);
                  }
                }

                if (timeout > 0 && new Date().getTime() - start > timeout) {
                  return reject(new Error("Transaction " + tx + " wasn't processed in " + (timeout / 1000) + " seconds!"));
                }

                setTimeout(make_attempt, 1000);
              });
            };

            make_attempt();
          };

          args.push(tx_params, callback);
          fn.apply(self, args);
        });
      };
    }
  };

  function instantiate(instance, contract) {
    instance.contract = contract;
    var constructor = instance.constructor;

    // Provision our functions.
    for (var i = 0; i < instance.abi.length; i++) {
      var item = instance.abi[i];
      if (item.type == "function") {
        if (item.constant == true) {
          instance[item.name] = Utils.promisifyFunction(contract[item.name], constructor);
        } else {
          instance[item.name] = Utils.synchronizeFunction(contract[item.name], instance, constructor);
        }

        instance[item.name].call = Utils.promisifyFunction(contract[item.name].call, constructor);
        instance[item.name].sendTransaction = Utils.promisifyFunction(contract[item.name].sendTransaction, constructor);
        instance[item.name].request = contract[item.name].request;
        instance[item.name].estimateGas = Utils.promisifyFunction(contract[item.name].estimateGas, constructor);
      }

      if (item.type == "event") {
        instance[item.name] = contract[item.name];
      }
    }

    instance.allEvents = contract.allEvents;
    instance.address = contract.address;
    instance.transactionHash = contract.transactionHash;
  };

  // Use inheritance to create a clone of this contract,
  // and copy over contract's static functions.
  function mutate(fn) {
    var temp = function Clone() { return fn.apply(this, arguments); };

    Object.keys(fn).forEach(function(key) {
      temp[key] = fn[key];
    });

    temp.prototype = Object.create(fn.prototype);
    bootstrap(temp);
    return temp;
  };

  function bootstrap(fn) {
    fn.web3 = new Web3();
    fn.class_defaults  = fn.prototype.defaults || {};

    // Set the network iniitally to make default data available and re-use code.
    // Then remove the saved network id so the network will be auto-detected on first use.
    fn.setNetwork("default");
    fn.network_id = null;
    return fn;
  };

  // Accepts a contract object created with web3.eth.contract.
  // Optionally, if called without `new`, accepts a network_id and will
  // create a new version of the contract abstraction with that network_id set.
  function Contract() {
    if (this instanceof Contract) {
      instantiate(this, arguments[0]);
    } else {
      var C = mutate(Contract);
      var network_id = arguments.length > 0 ? arguments[0] : "default";
      C.setNetwork(network_id);
      return C;
    }
  };

  Contract.currentProvider = null;

  Contract.setProvider = function(provider) {
    var wrapped = new Provider(provider);
    this.web3.setProvider(wrapped);
    this.currentProvider = provider;
  };

  Contract.new = function() {
    if (this.currentProvider == null) {
      throw new Error("EscrowAdvansed error: Please call setProvider() first before calling new().");
    }

    var args = Array.prototype.slice.call(arguments);

    if (!this.unlinked_binary) {
      throw new Error("EscrowAdvansed error: contract binary not set. Can't deploy new instance.");
    }

    var regex = /__[^_]+_+/g;
    var unlinked_libraries = this.binary.match(regex);

    if (unlinked_libraries != null) {
      unlinked_libraries = unlinked_libraries.map(function(name) {
        // Remove underscores
        return name.replace(/_/g, "");
      }).sort().filter(function(name, index, arr) {
        // Remove duplicates
        if (index + 1 >= arr.length) {
          return true;
        }

        return name != arr[index + 1];
      }).join(", ");

      throw new Error("EscrowAdvansed contains unresolved libraries. You must deploy and link the following libraries before you can deploy a new version of EscrowAdvansed: " + unlinked_libraries);
    }

    var self = this;

    return new Promise(function(accept, reject) {
      var contract_class = self.web3.eth.contract(self.abi);
      var tx_params = {};
      var last_arg = args[args.length - 1];

      // It's only tx_params if it's an object and not a BigNumber.
      if (Utils.is_object(last_arg) && !Utils.is_big_number(last_arg)) {
        tx_params = args.pop();
      }

      tx_params = Utils.merge(self.class_defaults, tx_params);

      if (tx_params.data == null) {
        tx_params.data = self.binary;
      }

      // web3 0.9.0 and above calls new twice this callback twice.
      // Why, I have no idea...
      var intermediary = function(err, web3_instance) {
        if (err != null) {
          reject(err);
          return;
        }

        if (err == null && web3_instance != null && web3_instance.address != null) {
          accept(new self(web3_instance));
        }
      };

      args.push(tx_params, intermediary);
      contract_class.new.apply(contract_class, args);
    });
  };

  Contract.at = function(address) {
    if (address == null || typeof address != "string" || address.length != 42) {
      throw new Error("Invalid address passed to EscrowAdvansed.at(): " + address);
    }

    var contract_class = this.web3.eth.contract(this.abi);
    var contract = contract_class.at(address);

    return new this(contract);
  };

  Contract.deployed = function() {
    if (!this.address) {
      throw new Error("Cannot find deployed address: EscrowAdvansed not deployed or address not set.");
    }

    return this.at(this.address);
  };

  Contract.defaults = function(class_defaults) {
    if (this.class_defaults == null) {
      this.class_defaults = {};
    }

    if (class_defaults == null) {
      class_defaults = {};
    }

    var self = this;
    Object.keys(class_defaults).forEach(function(key) {
      var value = class_defaults[key];
      self.class_defaults[key] = value;
    });

    return this.class_defaults;
  };

  Contract.extend = function() {
    var args = Array.prototype.slice.call(arguments);

    for (var i = 0; i < arguments.length; i++) {
      var object = arguments[i];
      var keys = Object.keys(object);
      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var value = object[key];
        this.prototype[key] = value;
      }
    }
  };

  Contract.all_networks = {
  "default": {
    "abi": [
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "name": "escrows",
        "outputs": [
          {
            "name": "buyer",
            "type": "address"
          },
          {
            "name": "lockedFunds",
            "type": "uint256"
          },
          {
            "name": "frozenFunds",
            "type": "uint256"
          },
          {
            "name": "frozenTime",
            "type": "uint64"
          },
          {
            "name": "buyerNo",
            "type": "bool"
          },
          {
            "name": "sellerNo",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_dataInfo",
            "type": "string"
          },
          {
            "name": "_version",
            "type": "uint256"
          }
        ],
        "name": "cancel",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "seller",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "freezePeriod",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "status",
        "outputs": [
          {
            "name": "",
            "type": "uint16"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_lockId",
            "type": "uint256"
          },
          {
            "name": "_dataInfo",
            "type": "string"
          },
          {
            "name": "_version",
            "type": "uint256"
          }
        ],
        "name": "start",
        "outputs": [],
        "payable": true,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "rewardPromille",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [],
        "name": "kill",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_lockId",
            "type": "uint256"
          },
          {
            "name": "_dataInfo",
            "type": "string"
          },
          {
            "name": "_version",
            "type": "uint256"
          }
        ],
        "name": "reject",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_lockId",
            "type": "uint256"
          },
          {
            "name": "_dataInfo",
            "type": "string"
          },
          {
            "name": "_version",
            "type": "uint256"
          }
        ],
        "name": "accept",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "totalEscrows",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "feeFunds",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_lockId",
            "type": "uint256"
          },
          {
            "name": "_dataInfo",
            "type": "string"
          },
          {
            "name": "_version",
            "type": "uint256"
          }
        ],
        "name": "yes",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "name": "buyers",
        "outputs": [
          {
            "name": "",
            "type": "bool"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "contentCount",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "logsCount",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "feePromille",
        "outputs": [
          {
            "name": "",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "constant": false,
        "inputs": [
          {
            "name": "_dataInfo",
            "type": "string"
          },
          {
            "name": "_version",
            "type": "uint256"
          }
        ],
        "name": "addDescription",
        "outputs": [],
        "payable": false,
        "type": "function"
      },
      {
        "constant": true,
        "inputs": [],
        "name": "arbiter",
        "outputs": [
          {
            "name": "",
            "type": "address"
          }
        ],
        "payable": false,
        "type": "function"
      },
      {
        "inputs": [
          {
            "name": "_arbiter",
            "type": "address"
          },
          {
            "name": "_freezePeriod",
            "type": "uint256"
          },
          {
            "name": "_feePromille",
            "type": "uint256"
          },
          {
            "name": "_rewardPromille",
            "type": "uint256"
          }
        ],
        "payable": false,
        "type": "constructor"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "message",
            "type": "string"
          }
        ],
        "name": "LogDebug",
        "type": "event"
      },
      {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "lockId",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "dataInfo",
            "type": "string"
          },
          {
            "indexed": true,
            "name": "version",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "eventType",
            "type": "uint16"
          },
          {
            "indexed": true,
            "name": "sender",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "payment",
            "type": "uint256"
          }
        ],
        "name": "LogEvent",
        "type": "event"
      }
    ],
    "unlinked_binary": "0x60606040526000600b556000600c55346100005760405160808061107b83398101604090815281516020830151918301516060909301519092905b60008054600160a060020a03338116600160a060020a03199283161790925560018054928716929091169190911781556002849055600383905560048290556008805461ffff191690911790555b505050505b610fdf8061009c6000396000f300606060405236156100eb5763ffffffff60e060020a600035041663012f52ee81146100f057806306909f691461014a57806308551a53146101a15780630a3cb663146101ca578063200d2ed2146101e95780632fe2221c1461020d578063309e21a91461026057806341c0e1b51461027f5780634ca18ebd1461028e578063553bf56d146102e657806363ee7c8d1461033e5780636fd637281461035d57806395a5dfc01461037c57806397a993aa146103d4578063cc45969614610401578063cd1f839314610420578063dc3ef6851461043f578063eda50e331461045e578063fe25e00a146104b5575b610000565b34610000576101006004356104de565b60408051600160a060020a03909716875260208701959095528585019390935267ffffffffffffffff909116606085015215156080840152151560a0830152519081900360c00190f35b346100005761019f600480803590602001908201803590602001908080601f01602080910402602001604051908101604052809392919081815260200183838082843750949650509335935061053a92505050565b005b34610000576101ae610622565b60408051600160a060020a039092168252519081900360200190f35b34610000576101d7610631565b60408051918252519081900360200190f35b34610000576101f6610637565b6040805161ffff9092168252519081900360200190f35b60408051602060046024803582810135601f810185900485028601850190965285855261019f9583359593946044949392909201918190840183828082843750949650509335935061064192505050565b005b34610000576101d76107f9565b60408051918252519081900360200190f35b346100005761019f6107ff565b005b346100005760408051602060046024803582810135601f810185900485028601850190965285855261019f958335959394604494939290920191819084018382808284375094965050933593506108e592505050565b005b346100005760408051602060046024803582810135601f810185900485028601850190965285855261019f958335959394604494939290920191819084018382808284375094965050933593506109e092505050565b005b34610000576101d7610ad6565b60408051918252519081900360200190f35b34610000576101d7610adc565b60408051918252519081900360200190f35b346100005760408051602060046024803582810135601f810185900485028601850190965285855261019f95833595939460449493929092019181908401838280828437509496505093359350610ae292505050565b005b34610000576103ed600160a060020a0360043516610dfe565b604080519115158252519081900360200190f35b34610000576101d7610e13565b60408051918252519081900360200190f35b34610000576101d7610e19565b60408051918252519081900360200190f35b34610000576101d7610e1f565b60408051918252519081900360200190f35b346100005761019f600480803590602001908201803590602001908080601f016020809104026020016040519081016040528093929190818152602001838380828437509496505093359350610e2592505050565b005b34610000576101ae610f01565b60408051600160a060020a039092168252519081900360200190f35b6007602052600090815260409020805460018201546002830154600390930154600160a060020a0390921692909167ffffffffffffffff81169060ff680100000000000000008204811691690100000000000000000090041686565b60005433600160a060020a0390811691161461055557610000565b6008805461ffff191660021790556040805160046020808301829052600093830184905260608084528651908401528551600160a060020a0333169486949093600080516020610f948339815191529389939192869290918291608083019187019080838382156105e1575b8051825260208311156105e157601f1990920191602091820191016105c1565b505050905090810190601f16801561060d5780820380516001836020036101000a031916815260200191505b5094505050505060405180910390a45b5b5050565b600054600160a060020a031681565b60025481565b60085461ffff1681565b6008546000908190819061ffff1660011461065b57610000565b6103e8600354111561066c57610000565b6103e8600454111561067d57610000565b6103e860045460035401111561069257610000565b6000868152600760205260408120600181015490945011156106b357610000565b6003546103e8903402049150348211156106cc57610000565b506005805482019055600680546001908101909155825473ffffffffffffffffffffffffffffffffffffffff191633600160a060020a031690811784553483810385840181905560006002870181905560038701805469ffff00000000000000001916905583815260096020908152604091829020805460ff191687179055815180820187905291820184905260608083528a51908301528951929589948c94600080516020610f94833981519152948d949091829160808301919087019080838382156107b5575b8051825260208311156107b557601f199092019160209182019101610795565b505050905090810190601f1680156107e15780820380516001836020036101000a031916815260200191505b5094505050505060405180910390a45b505050505050565b60045481565b60005433600160a060020a0390811691161461081a57610000565b60006006541115610878576040805160208082526010908201527f746f74616c457363726f7773203e203000000000000000000000000000000000818301529051600080516020610f748339815191529181900360600190a16108e2565b600060055411156108d657604080516020808252600c908201527f66656546756e6473203e20300000000000000000000000000000000000000000818301529051600080516020610f748339815191529181900360600190a16108e2565b33600160a060020a0316ff5b5b565b6000805433600160a060020a0390811691161461090157610000565b50600083815260076020526040902061091b848484610ae2565b33600160a060020a03168285600080516020610f94833981519152866003866001015460405180806020018461ffff1661ffff16815260200183815260200182810382528581815181526020019150805190602001908083836000831461099d575b80518252602083111561099d57601f19909201916020918201910161097d565b505050905090810190601f1680156109c95780820380516001836020036101000a031916815260200191505b5094505050505060405180910390a45b5b50505050565b6000805433600160a060020a039081169116146109fc57610000565b60076000858152602001908152602001600020905033600160a060020a03168285600080516020610f94833981519152866002866001015460405180806020018461ffff1661ffff16815260200183815260200182810382528581815181526020019150805190602001908083836000831461099d575b80518252602083111561099d57601f19909201916020918201910161097d565b505050905090810190601f1680156109c95780820380516001836020036101000a031916815260200191505b5094505050505060405180910390a45b5b50505050565b60065481565b60055481565b600083815260076020526040812060018101549091901515610b51576040805160208082526015908201527f696e666f2e6c6f636b656446756e6473203d3d20300000000000000000000000818301529051600080516020610f748339815191529181900360600190a1610df7565b815433600160a060020a03908116911614801590610b7e575060005433600160a060020a03908116911614155b15610bfc576040805160208082526030908201527f6d73672e73656e64657220213d20696e666f2e6275796572202626206d73672e818301527f73656e64657220213d2073656c6c65720000000000000000000000000000000060608201529051600080516020610f748339815191529181900360800190a1610df7565b506001810154600160a060020a03301631811115610c67576040805160208082526016908201527f7061796d656e74203e20746869732e62616c616e636500000000000000000000818301529051600080516020610f748339815191529181900360600190a1610df7565b815433600160a060020a0390811691161415610c9857600054610c9390600160a060020a031682610f10565b610d1c565b60005433600160a060020a0390811691161415610cc9578154610c9390600160a060020a031682610f10565b610d1c565b6040805160208082526012908201527f756e6b6e6f776e206d73672e73656e6465720000000000000000000000000000818301529051600080516020610f748339815191529181900360600190a1610df7565b5b60006006541115610d3357600680546000190190555b6000826001018190555033600160a060020a03168386600080516020610f9483398151915287600b8660405180806020018461ffff1661ffff168152602001838152602001828103825285818151815260200191508051906020019080838360008314610dbb575b805182526020831115610dbb57601f199092019160209182019101610d9b565b505050905090810190601f168015610de75780820380516001836020036101000a031916815260200191505b5094505050505060405180910390a45b5050505050565b60096020526000908152604090205460ff1681565b600b5481565b600c5481565b60035481565b60005433600160a060020a03908116911614610e4057610000565b33600160a060020a0316816000600080516020610f9483398151915285600a600060405180806020018461ffff1661ffff1681526020018381526020018281038252858181518152602001915080519060200190808383600083146105e1575b8051825260208311156105e157601f1990920191602091820191016105c1565b505050905090810190601f16801561060d5780820380516001836020036101000a031916815260200191505b5094505050505060405180910390a45b5b5050565b600154600160a060020a031681565b600a5460ff1615610f2057610000565b600a805460ff19166001179055604051600160a060020a038316906161a89083906000818181858888f193505050501515610f6457600a805460ff19169055610000565b600a805460ff191690555b50505600d44da6836c8376d1693e8b9cacf1c39b9bed3599164ad6d8e60902515f83938e741f01a9fb5039b148b89c9fb0f21daf0daa3d0daa4b8cd8b382c3e61e5df503a165627a7a7230582052d44476536d0f0f057d7ab91f523a5c004a929a2de07cdeebb09d9f701f41570029",
    "events": {
      "0xd44da6836c8376d1693e8b9cacf1c39b9bed3599164ad6d8e60902515f83938e": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": false,
            "name": "message",
            "type": "string"
          }
        ],
        "name": "LogDebug",
        "type": "event"
      },
      "0xe9a88fc67f5ad8c6d6e6fb2832af9558ebc4c2f6395337eec27c17f1ee9ebc1f": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "lockId",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "dataInfo",
            "type": "string"
          },
          {
            "indexed": true,
            "name": "version",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "eventType",
            "type": "uint16"
          },
          {
            "indexed": true,
            "name": "sender",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "count",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "payment",
            "type": "uint256"
          }
        ],
        "name": "LogEvent",
        "type": "event"
      },
      "0x741f01a9fb5039b148b89c9fb0f21daf0daa3d0daa4b8cd8b382c3e61e5df503": {
        "anonymous": false,
        "inputs": [
          {
            "indexed": true,
            "name": "lockId",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "dataInfo",
            "type": "string"
          },
          {
            "indexed": true,
            "name": "version",
            "type": "uint256"
          },
          {
            "indexed": false,
            "name": "eventType",
            "type": "uint16"
          },
          {
            "indexed": true,
            "name": "sender",
            "type": "address"
          },
          {
            "indexed": false,
            "name": "payment",
            "type": "uint256"
          }
        ],
        "name": "LogEvent",
        "type": "event"
      }
    },
    "updated_at": 1486638630850
  }
};

  Contract.checkNetwork = function(callback) {
    var self = this;

    if (this.network_id != null) {
      return callback();
    }

    this.web3.version.network(function(err, result) {
      if (err) return callback(err);

      var network_id = result.toString();

      // If we have the main network,
      if (network_id == "1") {
        var possible_ids = ["1", "live", "default"];

        for (var i = 0; i < possible_ids.length; i++) {
          var id = possible_ids[i];
          if (Contract.all_networks[id] != null) {
            network_id = id;
            break;
          }
        }
      }

      if (self.all_networks[network_id] == null) {
        return callback(new Error(self.name + " error: Can't find artifacts for network id '" + network_id + "'"));
      }

      self.setNetwork(network_id);
      callback();
    })
  };

  Contract.setNetwork = function(network_id) {
    var network = this.all_networks[network_id] || {};

    this.abi             = this.prototype.abi             = network.abi;
    this.unlinked_binary = this.prototype.unlinked_binary = network.unlinked_binary;
    this.address         = this.prototype.address         = network.address;
    this.updated_at      = this.prototype.updated_at      = network.updated_at;
    this.links           = this.prototype.links           = network.links || {};
    this.events          = this.prototype.events          = network.events || {};

    this.network_id = network_id;
  };

  Contract.networks = function() {
    return Object.keys(this.all_networks);
  };

  Contract.link = function(name, address) {
    if (typeof name == "function") {
      var contract = name;

      if (contract.address == null) {
        throw new Error("Cannot link contract without an address.");
      }

      Contract.link(contract.contract_name, contract.address);

      // Merge events so this contract knows about library's events
      Object.keys(contract.events).forEach(function(topic) {
        Contract.events[topic] = contract.events[topic];
      });

      return;
    }

    if (typeof name == "object") {
      var obj = name;
      Object.keys(obj).forEach(function(name) {
        var a = obj[name];
        Contract.link(name, a);
      });
      return;
    }

    Contract.links[name] = address;
  };

  Contract.contract_name   = Contract.prototype.contract_name   = "EscrowAdvansed";
  Contract.generated_with  = Contract.prototype.generated_with  = "3.2.0";

  // Allow people to opt-in to breaking changes now.
  Contract.next_gen = false;

  var properties = {
    binary: function() {
      var binary = Contract.unlinked_binary;

      Object.keys(Contract.links).forEach(function(library_name) {
        var library_address = Contract.links[library_name];
        var regex = new RegExp("__" + library_name + "_*", "g");

        binary = binary.replace(regex, library_address.replace("0x", ""));
      });

      return binary;
    }
  };

  Object.keys(properties).forEach(function(key) {
    var getter = properties[key];

    var definition = {};
    definition.enumerable = true;
    definition.configurable = false;
    definition.get = getter;

    Object.defineProperty(Contract, key, definition);
    Object.defineProperty(Contract.prototype, key, definition);
  });

  bootstrap(Contract);

  if (typeof module != "undefined" && typeof module.exports != "undefined") {
    module.exports = Contract;
  } else {
    // There will only be one version of this contract in the browser,
    // and we can use that.
    window.EscrowAdvansed = Contract;
  }
})();
